# Raspberry Pi firmware - smart access + environment monitor

This folder is the program that runs on the Raspberry Pi. Copy the whole folder to
the Pi (for example `~/smart-access/device/`) and run `python main.py`. It is the
firmware itself, not a set of test scripts.

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

`.env` holds three lines:

```
SERVER_URL=http://<laptop-ip>:3000
DEVICE_API_KEY=<plain key whose SHA-256 hash is in devices.api_key_hash>
DEVICE_UID=main-entrance-pi
```

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
4. the PIN typed twice on the keypad (`#` confirms, `*` clears).

The card ID (hashed with SHA-256) and the PIN (hashed with bcrypt) are stored in the
database. Press Enter at the name prompt to finish.

**When everyone is registered, open `main.py`, find `run_enrolment(hw, api)` in `main()`
and comment it out** (put a `#` in front). From then on the firmware starts directly in
normal operation.

### Step 2 - normal operation

| Action | Result | Buzzer |
|---|---|---|
| Firmware starts | Ready | 2 short beeps |
| Key pressed | Digit recorded | tiny tick |
| First factor entered | Enter PIN then tap card, or tap card then enter PIN and press `#` | Key tick / card read tick |
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
  state, fan and door logic continue. The DHT runs in its own process, so a crash there
  cannot stop the door.
- **Bad data:** the backend validates every payload and the Pi logs rejections.

## Settings you may want to change (`config.py`)

`SERVO_OPEN_ANGLE` / `SERVO_LOCKED_ANGLE`, `RELAY_ACTIVE_HIGH` (set False if the fan runs
when it should be off), `MQ3_ACTIVE_LOW`, `DHT_TYPE` (DHT22 or DHT11), `FAN_ON_TEMP_C`,
`FAN_ON_HUMIDITY`, `MAX_FAILS`, `LOCKOUT_S`, `AUTO_RELOCK_S`, `SNAPSHOT_ON_GRANTED`.

The log is also written to `device.log`.
