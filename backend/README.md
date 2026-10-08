# Smart Access Monitor backend

Express API matched to `smart_access_schema_final.sql`. It uses `admins`, `users`, `cards`, `devices`, `readings`, `snapshots`, `access_logs` and `alerts`.

## Database setup

The final schema script is intended for a **new or empty database**. Do not import it over an existing database. The configured database was inspected during this review and has all eight expected tables. For a fresh installation, create a separate database and import the supplied schema:

```powershell
createdb -h localhost -U postgres smart_access_final
psql -h localhost -U postgres -d smart_access_final -v ON_ERROR_STOP=1 -f smart_access_schema_final.sql
```

Set `DB_NAME=smart_access_final` (and your local PostgreSQL password) in `.env`. Keep `.env` private. Set `JWT_SECRET` to a long random value. The final schema file is copied into this backend folder for convenient import.

From the `backend` folder, install dependencies:

```powershell
npm install
```

Create the first dashboard admin and register the Raspberry Pi. Choose private values for these credentials; they are only read from your shell environment:

```powershell
$env:ADMIN_USERNAME = 'admin'
$env:ADMIN_PASSWORD = 'choose-a-strong-password'
$env:DEVICE_API_KEY = 'choose-a-long-random-device-key'
npm run setup
Remove-Item Env:ADMIN_PASSWORD
npm start
```

Setup hashes the admin password with bcrypt and the Pi key with SHA-256. It does not overwrite existing admin/device credentials. `DEVICE_UID` can select another UID; it defaults to `main-entrance-pi`.

To rotate the key for an already registered device without deleting its history, set `DEVICE_UID` and `DEVICE_API_KEY` in the shell, then run `npm run rotate-device-key`. Update that device's `.env` with the same new plain key immediately afterward.

The device selection page lists all registered devices from PostgreSQL. To register another device, run setup with a different `DEVICE_UID`, `DEVICE_NAME`, and `DEVICE_API_KEY`; existing credentials are preserved. A separate simulated-room setup is not needed.

Open `http://localhost:3000/login` after starting the server. Login stores the JWT in an HTTP-only cookie. `/rooms` lists devices and `/dashboard?device_uid=...` opens the selected device. Log out from the page header to clear the cookie. The frontend refreshes every five seconds and retries after connection failures.

## Simulated room

In a separate terminal in `backend`, run `npm run simulate`. It writes a simulated reading to PostgreSQL every five seconds for `simulated-room-pi`, creating that device if needed. It also generates labelled access events and cycles environmental alerts through active/cleared states. The real room and existing device credentials are unchanged. Stop with Ctrl+C; the device becomes offline after two minutes. Use `npm run simulate -- --once` for one sample.

This is a local database demo script using the database configuration in `.env`; it does not test device API authentication or replace the assignment's real sensor requirement. Camera snapshots are not fabricated.

Open `/dashboard?device_uid=simulated-room-pi` after signing in to see its live values and history.

## API routes

The browser login sets an HTTP-only JWT cookie; API clients can also send `Authorization: Bearer TOKEN`, received from `POST /api/login`. Pi routes need `X-API-Key` and `device_uid` in the body.

- `POST /api/login` — dashboard username and password.
- `POST /api/device/verify-access` — Pi device key plus `{ "device_uid":"main-entrance-pi", "card_uid":"<card UID>", "pin":"1234" }`. The server grants only when the active card and that user's bcrypt-verified PIN match. The Pi may collect the PIN first or the card first; it submits both together. Invalid card/PIN pairs receive a generic denial, and repeated known-user PIN failures are rate-limited.
- `POST /api/telemetry` — `{ "device_uid":"main-entrance-pi", "temperature":24.6, "humidity":58, "gas_present":false, "fan_on":false }`. All four reading fields are required; use JSON `null` for an unavailable sensor or unknown fan state. Invalid types and out-of-range values are rejected. Missing values appear as unavailable and do not clear existing alerts. Inserts one reading, updates `devices.last_seen`, creates alerts above thresholds (30 °C and 70% by default), and resolves alerts when conditions clear.
- `GET /api/dashboard` or `/api/dashboard/current` — current KPI values, gas/fan status, device online and `last_seen`. Optional `?device_uid=main-entrance-pi` selects a device; otherwise the most recently seen device is returned. Online means seen within two minutes.
- `GET /api/devices` — device records and online status for the room selection page; credential hashes are not returned.
- `GET /api/readings?limit=50` — temperature/humidity history, with newest limited records returned oldest first for charting. Optional `device_uid` filter.
- `POST /api/access` — Pi access result: `method` (`rfid`/`pin`), `result` (`granted`/`denied`), optional `reason`, `user_id`, `card_id`, `snapshot_id`.
- `GET /api/access` or `/api/access-logs?limit=20` — latest access attempts with `users.name` joined as `user_name`; unknown users appear as null.
- `POST /api/snapshots` — multipart form fields `device_uid`, optional `reason`, and image field named `image` (JPEG, PNG or WebP, up to 5 MB). Stores files in `uploads/` and only the path in PostgreSQL.
- `GET /api/snapshots/latest` — newest snapshot path, reason, capture time and device name. Optional device filter.
- `GET /api/alerts?limit=50` — newest alerts, with `Active`/`Cleared` derived from `resolved_at`.

`HIGH_TEMPERATURE_THRESHOLD` and `HIGH_HUMIDITY_THRESHOLD` can be set in `.env`; defaults are 30 and 70. SQL values are parameterized. `limit` accepts 1–1000 and defaults to 50. Camera files are served under `/uploads/...`.

## Test

`npm test` runs a PostgreSQL and HTTP integration check against the configured database and removes its unique test records afterward. Import the final schema first and configure `.env` to point at that database. Tests cover login, telemetry, latest KPIs, history, joined access logs, camera snapshots, alert generation/deduplication/resolution and online timeout.

See [assignment review](../docs/assignment-review.md) for requirement coverage and remaining submission evidence.
