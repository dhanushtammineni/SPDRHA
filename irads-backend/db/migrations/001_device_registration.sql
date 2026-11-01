
CREATE TABLE IF NOT EXISTS registered_devices (
    device_id_hash CHAR(64) PRIMARY KEY,
    credential_hash CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    CONSTRAINT valid_device_hash
        CHECK (device_id_hash ~ '^[0-9a-f]{64}$'),

    CONSTRAINT valid_credential_hash
        CHECK (credential_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS registered_devices_active_idx
    ON registered_devices (is_active);
