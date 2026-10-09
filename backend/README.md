# Smart Access Monitor backend

Node.js/Express serves both the REST API and the EJS dashboard. PostgreSQL stores admins, enrolled people/cards, devices, readings, snapshots metadata, access logs, and alerts. In production, deploy this folder as the Render Web Service; Vercel is not needed for the current same-origin frontend.

## Database setup

The schema script is intended for a **new or empty database**. Do not import it over an existing database. For a fresh local installation, create a database and import the schema:

```powershell
createdb -h localhost -U postgres smart_access_final
psql -h localhost -U postgres -d smart_access_final -v ON_ERROR_STOP=1 -f smart_access_schema_final.sql
```

Set `DB_NAME=smart_access_final` (and local PostgreSQL credentials) in `backend/.env`. `db.js` loads that file. Keep `.env` private and set `JWT_SECRET` to a long random value.

For Render, import the schema into the new hosted database using its **external** URL from your computer. Set the Render Web Service's `DATABASE_URL` to the database's **internal** URL. If `DATABASE_URL` is set, the `DB_*` connection fields are ignored. Keep both URLs private; never put database credentials in the Pi's `.env`.

From the `backend` folder, install dependencies:

```powershell
npm install
```

Create the first dashboard admin and register the Raspberry Pi. Put the database connection, `JWT_SECRET`, and chosen admin/device settings in the private `backend/.env`. Alternatively, provide the setup credentials in the shell. From the `backend` folder, run:

```powershell
$env:ADMIN_USERNAME = 'admin'
$env:ADMIN_PASSWORD = 'choose-a-strong-password'
$env:DEVICE_API_KEY = 'choose-a-long-random-device-key'
npm run setup
Remove-Item Env:ADMIN_PASSWORD
npm start
```

Setup hashes the admin password with bcrypt and the Pi key with SHA-256. It does not overwrite existing admin/device credentials. `DEVICE_UID` defaults to `main-entrance-pi`; `DEVICE_NAME` defaults to the UID. Local and Render databases are separate: an admin created locally does not automatically exist in Render. If that username already exists in the target database, setup does not update its password.

The dashboard login and Pi enrollment prompt use this database's admin username/password. The Pi's `DEVICE_API_KEY` is a separate credential. To rotate it without deleting device history, set the new `DEVICE_API_KEY` and matching `DEVICE_UID` in `backend/.env`, then run `npm run rotate-device-key`. Update the Pi's private `.env` with that exact new key.

The device selection page lists all registered devices from PostgreSQL. To register another device, run setup with a different `DEVICE_UID`, `DEVICE_NAME`, and `DEVICE_API_KEY`; existing credentials are preserved. A separate simulated-room setup is not needed.

Open `http://localhost:3000/login` after starting the local server. Login stores a JWT in an HTTP-only cookie. `/rooms` lists devices and `/dashboard?device_uid=...` opens the selected device. The frontend refreshes every five seconds and retries after connection failures.

## Render deployment

Create a Render PostgreSQL database and a Node Web Service from the repository. For the Web Service use root directory `backend`, build command `npm ci`, and start command `npm start`. Set `DATABASE_URL` to the database's internal URL, `JWT_SECRET` to a new private value, and `NODE_ENV=production`. Render supplies `PORT`. The service's public HTTPS URL serves both `/login` and `/api/...`; point the Pi's `SERVER_URL` at that public service URL, not at PostgreSQL.

Import the schema before setup, then run `npm run setup` once against the hosted database using the external database URL in your local `backend/.env`. Keep `.env` out of Git. Full Render setup and Pi/systemd instructions are in the [project README](../README.md) and [device README](../device/README.md).

## Simulated room

In a separate terminal in `backend`, run `npm run simulate`. This is a local process, not part of the Render Web Service. It writes a simulated reading to the PostgreSQL database configured in `backend/.env` every five seconds for `simulated-room-pi` (Room 2), creating that device if needed. To feed the deployed dashboard, point local `DATABASE_URL` at the Render **external** database URL. It also generates labelled access events and cycles environmental alerts; it does not create users or snapshots, and does not change the real Pi's records. Stop with Ctrl+C; use `npm run simulate -- --once` for one sample.

The simulator writes directly to PostgreSQL; it does not test device API authentication or replace the assignment's physical sensor requirement. Camera snapshots are not fabricated. No Render Background Worker is needed for a local demo; the simulator runs only while its local process is running.

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

`HIGH_TEMPERATURE_THRESHOLD` and `HIGH_HUMIDITY_THRESHOLD` can be set in `.env`; defaults are 30 and 70. SQL values are parameterized. `limit` accepts 1–1000 and defaults to 50. Camera files are served under `/uploads/...`, behind dashboard login.

Snapshot image bytes are written to `backend/uploads`; PostgreSQL stores only the file path and metadata. The application has no automatic snapshot-retention cleanup. Render's service filesystem is not persistent storage, so files may be lost on redeploy or instance replacement even while database metadata remains. Use a persistent disk or object storage for images that must be retained. The Pi also keeps captured files in `device/snapshots` and does not automatically prune them.

Telemetry accepts JSON `null` for unavailable sensor values. The dashboard labels missing DHT22 readings and detectable MQ-3 GPIO read errors as unavailable; a floating disconnected digital MQ-3 output cannot always be detected without hardware supervision. See the device guide for the unplug/recovery demo.

## Test

`npm test` runs a PostgreSQL and HTTP integration check against the configured database and removes its unique test records afterward. Import the final schema first and configure `.env` to point at that database. Tests cover login, telemetry, latest KPIs, history, joined access logs, camera snapshots, alert generation/deduplication/resolution and online timeout.

See [assignment review](../docs/assignment-review.md) for requirement coverage and remaining submission evidence.
