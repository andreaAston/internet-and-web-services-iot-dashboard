# Raspberry Pi firmware - smart access + environment monitor

This folder is the program that runs on the Raspberry Pi. Copy it to the Pi (for
example `~/Iot_firmware/`) and run `python main.py`. It is the firmware itself,
not a set of test scripts.

## What it does

| Job | How |
|---|---|
| Enrol people | Reads each card ID from the RC522 and the PIN from the keypad, and stores both in the database through the backend |
| Check access | The enrolled card and PIN are verified together; enter either first. Correct pair = servo opens to 90 degrees; the authorized user's PIN closes it |
| Protect | 3 wrong attempts = 30 s lockout. If the server is down, nobody gets in (fail secure) |
| Monitor the room | Every 5 s sends DHT temperature/humidity and the MQ3 gas state; fan relay switches on for gas, heat or humidity |
| Camera | Takes a photo on a failed attempt and uploads it |
| Indicate | One buzzer: boot, key presses, card result, PIN result, lockout, alarms |

## Files

| File | Purpose |
|---|---|
| `main.py` | The firmware: step 1 enrolment, step 2 normal operation |
| `config.py` | All pin numbers, thresholds, timings and API routes |
| `hardware.py` | Keypad, RC522, servo, relay, MQ3, buzzer, DHT monitor, camera |
| `dht_worker.py` | Reads the DHT sensor in its own process (started automatically) |
| `api_client.py` | Talks to the Express backend, fail-secure checks, offline queue |
| `requirements.txt` | Python packages |
| `.env.example` | Copy to `.env` and fill in. Never commit `.env` |
| `.gitignore` | Keeps `.env`, photos and runtime files out of GitHub |
| `iot-firmware.service` | systemd unit for starting firmware at boot |

## Pins (BCM numbering, from your test scripts)

| Part | GPIO | Physical pin |
|---|---|---|
| Relay (fan) | 17 | 11 |
| Servo | 22 | 15 |
| MQ3 digital out | 27 | 13 |
| DHT22 data | 4 | 7 |
| Buzzer (passive, PWM) | 23 | 16 |
| Keypad rows | 6, 26, 21, 19 | 31, 37, 40, 35 |
| Keypad columns | 13, 5, 20 | 33, 29, 38 |
| RC522 (SPI, 3.3V only) | SDA 8, SCK 11, MOSI 10, MISO 9, RST 25 | 24, 23, 19, 21, 22 |

The buzzer was moved from GPIO2 to GPIO23 because GPIO2 has a built-in pull-up that can
make a buzzer chirp at boot. For the two-leg passive buzzer, connect positive to physical
pin 16 (BCM GPIO23) and negative to GND. The firmware drives it with a 1.5 kHz PWM tone.
Directly connect only if the buzzer's current draw is within the Pi GPIO output limit;
otherwise use a transistor driver.

## One-time setup

```bash
source ~/rfid-venv/bin/activate
pip install -r requirements.txt          # new ones: requests, python-dotenv
cp .env.example .env && nano .env        # SERVER_URL, DEVICE_API_KEY, DEVICE_UID

# camera (installed on the Pi itself, not in the venv)
sudo apt update && sudo apt install -y fswebcam
sudo usermod -aG video $USER             # then log out and back in
fswebcam -d /dev/video0 -r 1280x720 --no-banner check.jpg    # optional: proves the camera works
```

For Render, set `.env` on the Pi to the public web-service URL, not the database URL:

```
SERVER_URL=https://<your-render-service>.onrender.com
DEVICE_API_KEY=<plain key whose SHA-256 hash is in devices.api_key_hash>
DEVICE_UID=main-entrance-pi
```

The device API key must exactly match the plain key registered for this `DEVICE_UID`; PostgreSQL stores its SHA-256 hash. Keep the key private. Never put the PostgreSQL URL or database password in the Pi's `.env`.

For a local backend instead, use its reachable LAN URL, such as `http://<laptop-ip>:3000`. The Pi and computer must be able to reach each other over the same LAN or a configured VPN.

### Rotate the device key

If the key is unknown or exposed, choose a new random key of at least 32 characters. Set it as `DEVICE_API_KEY` in `backend/.env`, keep `DEVICE_UID` set to the Pi's UID, then run this from `backend` to update the hash in PostgreSQL:

```bash
npm run rotate-device-key
```

Set the exact same new key in the Pi's `device/.env`. Restart the firmware afterward. The admin password and device API key are different credentials.

## Backend requirement

The backend includes the device routes in `backend/deviceAccess.js`, mounted in
`backend/server.js` after `express.json()`:

```js
app.use('/api', require('./deviceAccess'));
```

## Running it

```bash
python main.py
```

### Step 1 - enrolment (first run only)

`main()` starts with the enrolment step. For each person it asks for:

1. the admin username and password (once),
2. the person's name,
3. a card tap, which reads its card ID,
4. the PIN typed twice on the keypad (pause briefly after the digits to submit; `#` also submits, `*` clears).

The card ID (hashed with SHA-256) and the PIN (hashed with bcrypt) are stored in the
database. Press Enter at the name prompt to finish.

The admin credentials must exist in the same database used by the Render service. Use the dashboard admin username and password created by `npm run setup`; a local-only admin account is not automatically copied to Render. If the first Pi login times out while Render is waking, open the Render `/login` page in a browser, wait for it to load, then retry enrollment. The Pi request timeout is four seconds.

**When everyone is registered, open `main.py`, find `run_enrolment(hw, api)` in `main()`
Enrollment prompts only run when `main.py` is started from an interactive terminal. A
systemd boot service has no terminal, so it skips enrollment and enters normal operation.
To enroll someone later, stop the service and run `python main.py` manually in the Pi
terminal; start the service again after enrollment.

### Step 2 - normal operation

| Action | Result | Buzzer |
|---|---|---|
| Firmware starts | Ready | 2 short beeps |
| Key pressed | Digit recorded | tiny tick |
| First factor entered | Enter PIN then pause briefly and tap the card, or tap the card then enter the PIN and pause briefly (`#` also submits) | Key tick / card read tick |
| Correct card and PIN | Door opens (90 degrees) | 2 medium beeps |
| Invalid card/PIN pair | Access denied; photo taken | 1 long beep |
| 3 failures | 30 s lockout | 5 beeps |
| Correct PIN with door open | Door closes (0 degrees) | 2 medium beeps |
| Server unreachable | Denied, events queued | 2 long beeps |
| Gas / heat / humidity alarm | Fan relay on | double beep every 15 s |

## Camera logic

1. An attempt fails (unknown card or wrong PIN, including the one that causes a lockout).
2. The firmware runs `fswebcam`, which saves a JPG in `snapshots/`.
3. The photo is uploaded to `/api/snapshots` with `device_uid` and the reason.
4. The backend saves the image in `uploads/` and its path in the `snapshots` table, and
   the dashboard shows the latest one.
5. If the camera is unplugged, the photo is skipped, a warning is logged, and everything
   else keeps working. If the server is down, the photo waits in the offline queue.

Set `SNAPSHOT_ON_GRANTED = True` in `config.py` to photograph successful entries too.

## Resilience

- **Server down:** access is denied. Telemetry, access events and photos are stored in
  `offline_queue.db` and sent in order when the server returns.
- **Camera unplugged:** photo skipped, rest keeps working.
- **DHT unplugged:** temperature and humidity are left out of the telemetry, and the gas
  state, fan and door logic continue. The dashboard labels both readings `DHT22 unavailable`;
  they return to normal when valid readings resume. The DHT runs in its own process, so a
  crash there cannot stop the door.
- **MQ-3 GPIO read error:** the firmware logs `Gas sensor read failed`, sends a null gas
  value, and continues the telemetry loop. The dashboard labels the gas sensor unavailable.
  An unplugged digital output can float and look like a valid HIGH or LOW, so this software
  error handling cannot reliably detect every physical disconnection; guaranteed detection
  needs supervised wiring or a separate fault signal. An unknown gas value alone does not
  switch on the fan.
- **Bad data:** the backend validates every payload and the Pi logs rejections.

## Settings you may want to change (`config.py`)

`SERVO_OPEN_ANGLE` / `SERVO_LOCKED_ANGLE`, `RELAY_ACTIVE_HIGH` (set False if the fan runs
when it should be off), `MQ3_ACTIVE_LOW`, `DHT_TYPE` (DHT22 or DHT11), `FAN_ON_TEMP_C`,
`FAN_ON_HUMIDITY`, `MAX_FAILS`, `LOCKOUT_S`, `AUTO_RELOCK_S`, `SNAPSHOT_ON_GRANTED`.

The log is also written to `device.log`.

## Start automatically at boot

The included `iot-firmware.service` expects the Pi user `pi`, firmware directory
`/home/pi/Iot_firmware`, and virtual environment `/home/pi/rfid-venv`. If your paths or
username differ, edit those values in the unit file before installing it. Copy updated
firmware and the unit file from PowerShell at the project root:

```powershell
scp .\device\main.py .\device\hardware.py .\device\iot-firmware.service pi@<PI_LAN_IP>:~/Iot_firmware/
```

On the Pi, install and enable the service:

```bash
sudo install -m 644 ~/Iot_firmware/iot-firmware.service /etc/systemd/system/iot-firmware.service
sudo systemctl daemon-reload
sudo systemctl enable --now iot-firmware.service
sudo systemctl status iot-firmware.service --no-pager
```

`enable` starts the firmware now and again after future boots. Check live logs with
`journalctl -u iot-firmware.service -f`; use Ctrl+C to leave the log view. Stop or restart
the firmware with `sudo systemctl stop iot-firmware.service` or
`sudo systemctl restart iot-firmware.service`. A manual stop does not disable boot startup.

To enroll another person, stop the service, run the firmware interactively, then start
the service again:

```bash
sudo systemctl stop iot-firmware.service
cd ~/Iot_firmware
source ~/rfid-venv/bin/activate
python main.py
sudo systemctl start iot-firmware.service
```

## Copy updated firmware from Windows

With SSH enabled and the Pi reachable on the same LAN, run this in PowerShell from the
project root. Replace the address with the Pi's address from `hostname -I`:

```powershell
scp .\device\main.py .\device\hardware.py pi@<PI_LAN_IP>:~/Iot_firmware/
```

Copy the private config separately only when it needs updating; do not commit it or
share its contents:

```powershell
scp .\device\.env pi@<PI_LAN_IP>:~/Iot_firmware/.env
```

If the computer and Pi cannot reach each other over the network, transfer the files by
USB instead. On the Pi, stop the old firmware with Ctrl+C and restart it:

```bash
cd ~/Iot_firmware
source ~/rfid-venv/bin/activate
python main.py
```

## Fault demonstration

With the firmware sending data, remove the DHT22 connection and check the Pi log and
dashboard. The Pi should continue sending telemetry with `temperature: None` and
`humidity: None`; both dashboard cards should say **DHT22 unavailable** while the device
can remain online. Reconnect the sensor and valid values/status should return.

On an MQ-3 GPIO read exception, the Pi should log `Gas sensor read failed`, keep sending
telemetry, and the dashboard should say **Gas sensor unavailable**. A physically floating
MQ-3 output may not raise a GPIO exception, so this test does not guarantee detection of
every broken wire. Gas status `null` alone does not turn on the fan. The dashboard checks
data every five seconds; the device is marked offline only after two minutes without any
telemetry.
