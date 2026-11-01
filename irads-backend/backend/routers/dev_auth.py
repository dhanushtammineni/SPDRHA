
import hashlib
import hmac
import json
import os
import re
from datetime import datetime, timedelta, timezone

import redis.asyncio as redis
from fastapi import APIRouter, Header, HTTPException, Request
from jose import jwt
from pydantic import BaseModel

from backend.db.connection import get_pool

router = APIRouter()

JWT_ALGORITHM = "HS256"
DEVICE_RE = re.compile(r"^[0-9a-f]{64}$")
CREDENTIAL_RE = re.compile(r"^[0-9a-f]{64}$")


class DeviceRegistrationRequest(BaseModel):
    device_id_hash: str
    device_credential: str


class DeviceTokenRequest(BaseModel):
    device_id_hash: str


def valid_device(value: str) -> str:
    normalized = value.lower()

    if not DEVICE_RE.fullmatch(normalized):
        raise HTTPException(
            status_code=400,
            detail="Invalid device identity",
        )

    return normalized


def jwt_secret() -> str:
    secret = os.getenv("JWT_SECRET", "")

    if len(secret) < 32:
        raise HTTPException(
            status_code=503,
            detail="JWT authentication is not configured",
        )

    return secret


def issue_token(device_id: str) -> dict:
    expiry = datetime.now(timezone.utc) + timedelta(hours=12)

    token = jwt.encode(
        {
            "device_id": device_id,
            "exp": expiry,
        },
        jwt_secret(),
        algorithm=JWT_ALGORITHM,
    )

    return {
        "access_token": token,
        "token_type": "bearer",
    }


def credential_digest(credential: str) -> str:
    return hashlib.sha256(
        credential.encode("ascii")
    ).hexdigest()



async def registration_rate_limit(
    request: Request,
    device_id: str,
) -> None:
    address = (
        request.client.host
        if request.client
        else "unknown"
    )

    client = redis.Redis(
        host=os.getenv("REDIS_HOST", "127.0.0.1"),
        port=int(os.getenv("REDIS_PORT", "6379")),
        password=os.getenv("REDIS_PASSWORD") or None,
        db=int(os.getenv("REDIS_DB", "0")),
        socket_connect_timeout=3,
        socket_timeout=3,
    )

    try:
        ip_digest = hashlib.sha256(
            address.encode()
        ).hexdigest()

        key = (
            f"irads:registration:{ip_digest}:"
            f"{device_id}"
        )

        script = """
        local n = redis.call('INCR', KEYS[1])
        if n == 1 then
            redis.call('EXPIRE', KEYS[1], 3600)
        end
        return n
        """

        count = await client.eval(
            script,
            1,
            key,
        )

        if count > 10:
            raise HTTPException(
                status_code=429,
                detail="Too many registration attempts",
            )

    except redis.RedisError as exc:
        raise HTTPException(
            status_code=503,
            detail="Registration temporarily unavailable",
        ) from exc

    finally:
        await client.aclose()



@router.post("/api/v1/dev/register", status_code=201)
async def register_device(
    payload: DeviceRegistrationRequest,
    request: Request,
):
    device_id = valid_device(payload.device_id_hash)
    credential = payload.device_credential.lower()

    if not CREDENTIAL_RE.fullmatch(credential):
        raise HTTPException(
            status_code=400,
            detail="Invalid device credential",
        )

    jwt_secret()

    await registration_rate_limit(request, device_id)

    pool = get_pool()

    if pool is None:
        raise HTTPException(
            status_code=503,
            detail="Database unavailable",
        )

    digest = credential_digest(credential)

    try:
        async with pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    """
                    INSERT INTO registered_devices (
                        device_id_hash,
                        credential_hash
                    )
                    VALUES ($1, $2)
                    ON CONFLICT (device_id_hash) DO NOTHING
                    """,
                    device_id,
                    digest,
                )

                existing = await connection.fetchrow(
                    """
                    SELECT credential_hash, is_active
                    FROM registered_devices
                    WHERE device_id_hash = $1
                    """,
                    device_id,
                )

                if (
                    not existing
                    or not existing["is_active"]
                    or not hmac.compare_digest(
                        existing["credential_hash"].strip(),
                        digest,
                    )
                ):
                    raise HTTPException(
                        status_code=409,
                        detail="Device identity is already registered",
                    )

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Registration database unavailable",
        ) from exc

    return {
        "status": "registered",
        "device_id_hash": device_id,
    }


def get_pilot_devices() -> dict:
    try:
        devices = json.loads(
            os.getenv("IRADS_PILOT_DEVICE_KEYS_JSON", "")
        )

    except (TypeError, ValueError):
        return {}

    return devices if isinstance(devices, dict) else {}


@router.post("/api/v1/dev/token")
async def create_dev_token(
    payload: DeviceTokenRequest,
    x_device_key: str = Header(default=""),
    x_pilot_key: str = Header(default=""),
):
    device_id = valid_device(payload.device_id_hash)
    jwt_secret()

    # New APK: automatic registration credentials
    if x_device_key:
        if not CREDENTIAL_RE.fullmatch(
            x_device_key.lower()
        ):
            raise HTTPException(
                status_code=401,
                detail="Device is not authorized",
            )

        pool = get_pool()

        if pool is None:
            raise HTTPException(
                status_code=503,
                detail="Database unavailable",
            )

        async with pool.acquire() as conn:
            record = await conn.fetchrow(
                """
                SELECT credential_hash, is_active
                FROM registered_devices
                WHERE device_id_hash = $1
                """,
                device_id,
            )

            if (
                not record
                or not record["is_active"]
                or not hmac.compare_digest(
                    record["credential_hash"].strip(),
                    credential_digest(x_device_key.lower()),
                )
            ):
                raise HTTPException(
                    status_code=401,
                    detail="Device is not authorized",
                )

            await conn.execute(
                """
                UPDATE registered_devices
                SET last_seen_at = NOW()
                WHERE device_id_hash = $1
                """,
                device_id,
            )

        return issue_token(device_id)

    # Older APKs: existing pilot authentication
    expected = get_pilot_devices().get(device_id)

    if (
        not isinstance(expected, str)
        or len(expected) < 32
        or not hmac.compare_digest(
            expected.encode(),
            x_pilot_key.encode(),
        )
    ):
        raise HTTPException(
            status_code=401,
            detail="Device is not authorized",
        )

    return issue_token(device_id)
