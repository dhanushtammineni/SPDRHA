"""Loopback-only TCP bridges through tailscaled's SOCKS5 server (no OS routes)."""
import asyncio
import ipaddress
import os
import struct

PORTS = (25433, 26379, 29093)
TAILNET = ipaddress.ip_network("100.64.0.0/10")


def validate_target(value):
    target = ipaddress.ip_address(value)
    if not isinstance(target, ipaddress.IPv4Address) or target not in TAILNET:
        raise ValueError("IRADS_LAPTOP_TS_IP must be a Tailscale IPv4 address")
    return str(target)


async def open_socks(target, port, proxy_port=1055):
    reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
    try:
        writer.write(b"\x05\x01\x00")  # SOCKS5, no proxy-level authentication; loopback only.
        await writer.drain()
        if await reader.readexactly(2) != b"\x05\x00":
            raise ConnectionError("SOCKS negotiation rejected")
        writer.write(b"\x05\x01\x00\x01" + ipaddress.IPv4Address(target).packed + struct.pack("!H", port))
        await writer.drain()
        version, result, reserved, address_type = await reader.readexactly(4)
        if (version, result, reserved) != (5, 0, 0):
            raise ConnectionError(
                f"SOCKS connection rejected: destination={target}:{port}, "
                f"version={version}, result_code={result}, reserved={reserved}"
                )
        if address_type == 1:
            await reader.readexactly(4)
        elif address_type == 4:
            await reader.readexactly(16)
        elif address_type == 3:
            length = (await reader.readexactly(1))[0]
            await reader.readexactly(length)
        else:
            raise ConnectionError("Invalid SOCKS address type")
        await reader.readexactly(2)
        return reader, writer
    except BaseException:
        writer.close()
        await writer.wait_closed()
        raise


async def pump(reader, writer):
    while data := await reader.read(65536):
        writer.write(data)
        await writer.drain()
    if writer.can_write_eof():
        writer.write_eof()


async def relay(reader, writer, target, port, proxy_port=1055):
    remote_writer = None
    tasks = []
    try:
        remote_reader, remote_writer = await asyncio.wait_for(open_socks(target, port, proxy_port), 8)
        tasks = [asyncio.create_task(pump(reader, remote_writer)),
                 asyncio.create_task(pump(remote_reader, writer))]
        # Preserve half-close semantics; cap socket lifetime for long-lived backend connections.
        await asyncio.gather(*tasks)
    except (OSError, ConnectionError, asyncio.TimeoutError, asyncio.IncompleteReadError):
        pass  # Protocol clients receive a closed socket; never log credentials or payloads.
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for stream in (writer, remote_writer):
            if stream is not None:
                stream.close()
                try:
                    await stream.wait_closed()
                except OSError:
                    pass


async def main():
    target = validate_target(os.environ["IRADS_LAPTOP_TS_IP"])
    servers = []
    for port in PORTS:
        async def handle(reader, writer, port=port):
            await relay(reader, writer, target, port)
        servers.append(await asyncio.start_server(handle, "127.0.0.1", port, limit=65536))
    print("IRADS loopback forwarders started", flush=True)
    await asyncio.gather(*(server.serve_forever() for server in servers))


if __name__ == "__main__":
    asyncio.run(main())
