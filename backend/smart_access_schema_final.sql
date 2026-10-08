-- =====================================================================
-- SMART ACCESS + ENVIRONMENT MONITOR
-- Final PostgreSQL schema aligned with the final dashboard.
--
-- IMPORTANT:
-- Run this script in a NEW/FRESH PostgreSQL database named smart_access.
-- It intentionally removes the old door/lock, gas-level, system-event,
-- and sensor/device-fault concepts from the design.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Dashboard administrators
-- ---------------------------------------------------------------------
CREATE TABLE admins (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(50)  NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- 2. People allowed to access the protected area
-- ---------------------------------------------------------------------
CREATE TABLE users (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(100) NOT NULL,
    pin_hash   VARCHAR(255),
    active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- 3. RFID cards assigned to users
-- ---------------------------------------------------------------------
CREATE TABLE cards (
    id         SERIAL PRIMARY KEY,
    user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    uid_hash   CHAR(64) NOT NULL UNIQUE,
    label      VARCHAR(50),
    active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cards_user ON cards(user_id);

-- ---------------------------------------------------------------------
-- 4. Raspberry Pi devices
-- last_seen is used by the dashboard to determine Device Online/Offline.
-- ---------------------------------------------------------------------
CREATE TABLE devices (
    id           SERIAL PRIMARY KEY,
    device_uid   VARCHAR(100) NOT NULL UNIQUE,
    name         VARCHAR(100) NOT NULL,
    location     VARCHAR(100),
    api_key_hash CHAR(64) NOT NULL UNIQUE,
    last_seen    TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- 5. Environmental readings sent by the Raspberry Pi
--
-- Dashboard mapping:
--   temperature  -> Temperature KPI + history chart
--   humidity     -> Humidity KPI + history chart
--   gas_present  -> Gas Status KPI (SAFE / DETECTED)
--   fan_on       -> Fan KPI (ON / OFF)
--
-- The gas sensor is DIGITAL ONLY, so there is no gas level/ADC column.
-- ---------------------------------------------------------------------
CREATE TABLE readings (
    id          BIGSERIAL PRIMARY KEY,
    device_id   INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    temperature REAL,
    humidity    REAL,
    gas_present BOOLEAN,
    fan_on      BOOLEAN,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (humidity IS NULL OR (humidity >= 0 AND humidity <= 100))
);

CREATE INDEX idx_readings_device_time
    ON readings(device_id, recorded_at DESC);

-- ---------------------------------------------------------------------
-- 6. Camera snapshots
-- The image remains a file; PostgreSQL stores only its path.
-- ---------------------------------------------------------------------
CREATE TABLE snapshots (
    id          SERIAL PRIMARY KEY,
    device_id   INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    file_path   VARCHAR(255) NOT NULL,
    reason      VARCHAR(50),
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_snapshots_device_time
    ON snapshots(device_id, captured_at DESC);

-- ---------------------------------------------------------------------
-- 7. Access history
--
-- Dashboard columns:
--   Time | Method | User | Result | Reason
--
-- method: RFID or PIN
-- result: granted or denied
-- user_id may be NULL for an unknown RFID card or failed PIN.
-- ---------------------------------------------------------------------
CREATE TABLE access_logs (
    id          BIGSERIAL PRIMARY KEY,
    device_id   INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    user_id     INT REFERENCES users(id) ON DELETE SET NULL,
    card_id     INT REFERENCES cards(id) ON DELETE SET NULL,

    method      VARCHAR(10) NOT NULL
                CHECK (method IN ('rfid', 'pin')),

    result      VARCHAR(10) NOT NULL
                CHECK (result IN ('granted', 'denied')),

    reason      VARCHAR(50),

    snapshot_id INT REFERENCES snapshots(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_access_logs_device_time
    ON access_logs(device_id, created_at DESC);

CREATE INDEX idx_access_logs_result_time
    ON access_logs(result, created_at DESC);

-- ---------------------------------------------------------------------
-- 8. Environmental alerts
--
-- Only the three alert types shown on the final dashboard are stored:
--   high_temperature
--   high_humidity
--   gas_presence
--
-- resolved_at IS NULL     -> Active
-- resolved_at IS NOT NULL -> Cleared
-- ---------------------------------------------------------------------
CREATE TABLE alerts (
    id          SERIAL PRIMARY KEY,
    device_id   INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,

    type        VARCHAR(30) NOT NULL
                CHECK (
                    type IN (
                        'high_temperature',
                        'high_humidity',
                        'gas_presence'
                    )
                ),

    message     VARCHAR(255) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_alerts_device_time
    ON alerts(device_id, created_at DESC);

CREATE INDEX idx_alerts_active
    ON alerts(device_id, created_at DESC)
    WHERE resolved_at IS NULL;

COMMIT;

-- =====================================================================
-- FINAL TABLES
--   admins
--   users
--   cards
--   devices
--   readings
--   snapshots
--   access_logs
--   alerts
--
-- Raspberry Pi telemetry example:
--
-- {
--   "temperature": 24.6,
--   "humidity": 58.0,
--   "gas_present": false,
--   "fan_on": false
-- }
--
-- Dashboard:
--   KPI row       -> latest row from readings
--   Device status -> devices.last_seen
--   Access table  -> access_logs + users
--   Camera        -> snapshots
--   History chart -> readings
--   Recent alerts -> alerts
-- =====================================================================
