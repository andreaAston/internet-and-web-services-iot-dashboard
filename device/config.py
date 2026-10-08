"""
config.py - settings for the Raspberry Pi firmware.

ALL PIN NUMBERS ARE BCM (GPIO) NUMBERS, TAKEN FROM YOUR TEST SCRIPTS
--------------------------------------------------------------------
  relay_test.py   relay           GPIO17  (physical pin 11)
  test_servo.py   servo           GPIO22  (physical pin 15)
  test_mq3.py     MQ3 DO          GPIO27  (physical pin 13)
                  NOTE: the comment in test_mq3.py says "physical pin 30",
                  but pin 30 is a GND pin. GPIO27 is physical pin 13.
  test_dht22.py   DHT22 data      GPIO4   (physical pin 7)
  test_keypad.py  keypad rows     GPIO6, 26, 21, 19  (inputs, pull-up)
                  keypad columns  GPIO13, 5, 20      (outputs)
                  -> this is a 3-column x 4-row keypad (no A-D keys)
  test_rfid.py    RC522 on SPI0   SDA/CE0 = GPIO8 (pin 24), SCK = GPIO11 (pin 23),
                  MOSI = GPIO10 (pin 19), MISO = GPIO9 (pin 21),
                  RST = GPIO25 (pin 22), 3.3V ONLY (never 5V)
    buzzer          GPIO23  (physical pin 16)  passive two-leg buzzer, driven with PWM.
                  Moved off GPIO2: that pin has a fixed pull-up to 3.3V, so the
                                    buzzer could chirp every time the Pi boots. GPIO23 idles LOW.
                                    Two-leg buzzer: + -> pin 16, - -> GND; direct drive only when
                                    its current is within the Pi GPIO output limit.

SECRETS (server address, API key) come from the .env file, which must NOT
be committed to GitHub. Copy .env.example to .env and fill it in.
"""
import os

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:          # python-dotenv is optional; plain environment variables also work
    pass

# ----------------------------------------------------------------------------
# SERVER
# ----------------------------------------------------------------------------
SERVER_URL = os.getenv("SERVER_URL", "http://192.168.1.10:3000").rstrip("/")
DEVICE_API_KEY = os.getenv("DEVICE_API_KEY", "")
DEVICE_API_KEY_PLACEHOLDER = "put-the-real-key-here"
DEVICE_UID = os.getenv("DEVICE_UID", "main-entrance-pi")   # sent as device_uid in every request ("simulated-room-pi" is the simulated room)
API_KEY_HEADER = "X-API-Key"
REQUEST_TIMEOUT_S = 4

# Endpoints. The first four exist in your backend today (backend/README.md).
# The last three are NEW: they live in backend/deviceAccess.js, because the
# current API has no way to check a card, check a PIN or enrol a person.
ENDPOINTS = {
    "login":       "/api/login",               # POST {username, password} -> {token}
    "telemetry":   "/api/telemetry",           # POST (X-API-Key) readings
    "access":      "/api/access",              # POST (X-API-Key) access event log
    "snapshots":   "/api/snapshots",           # POST (X-API-Key) multipart photo
    "verify_access": "/api/device/verify-access", # POST {device_uid, card_uid, pin}
    "verify_card": "/api/device/verify-card",  # NEW  POST {device_uid, card_uid} -> {known, user_id, card_id, name}
    "verify_pin":  "/api/device/verify-pin",   # NEW  POST {device_uid, user_id, pin} -> {granted, reason}
    "enroll":      "/api/enroll",              # NEW  POST (admin JWT) {name, pin, card_uid}
}
SNAPSHOT_FIELD = "image"        # multipart field name the upload route expects

# ----------------------------------------------------------------------------
# PINS (BCM)
# ----------------------------------------------------------------------------
PIN_BUZZER = 23
BUZZER_TYPE = "passive"
BUZZER_FREQ_HZ = 1500
PIN_RELAY = 17
PIN_SERVO = 22
PIN_MQ3_DO = 27
PIN_DHT = 4
KEYPAD_ROWS = [6, 26, 21, 19]
KEYPAD_COLS = [13, 5, 20]
KEYPAD_KEYS = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    ["*", "0", "#"],
]

# ----------------------------------------------------------------------------
# DEVICE BEHAVIOUR
# ----------------------------------------------------------------------------
RELAY_ACTIVE_HIGH = True      # set False if the fan turns on when the pin goes LOW
MQ3_ACTIVE_LOW = True         # your test: LOW means "threshold detected"
DHT_TYPE = "DHT22"            # your test script uses DHT22; use "DHT11" for a DHT11
DHT_INTERVAL_S = 3.0
DHT_STALE_S = 15              # a DHT value older than this is treated as "sensor offline"

SERVO_LOCKED_ANGLE = 0
SERVO_OPEN_ANGLE = 90         # test_servo.py moved to 180; set what your door needs
AUTO_RELOCK_S = 0             # 0 = off. Door closes only when the PIN is entered again

PIN_MIN_LEN = 4
PIN_MAX_LEN = 8
PIN_TIMEOUT_S = 15            # time allowed to type the PIN after a card scan
MAX_FAILS = 3                 # wrong card/PIN attempts before lockout
LOCKOUT_S = 30
CARD_COOLDOWN_S = 1.0         # ignore the same card for this long after a scan

# Environment alarms (fan relay runs while any of these is active)
READING_INTERVAL_S = 5            # telemetry every few seconds
FAN_ON_TEMP_C = 30.0
FAN_HYST_C = 1.0
FAN_ON_HUMIDITY = 80.0
FAN_HYST_HUMIDITY = 5.0
ALARM_BUZZER = True           # double beep while an alarm is active...
ALARM_BEEP_EVERY_S = 15       # ...repeated this often

# ----------------------------------------------------------------------------
# CAMERA (USB webcam, captured with fswebcam)
# ----------------------------------------------------------------------------
CAMERA_DEVICE = "/dev/video0"
CAMERA_RESOLUTION = "1280x720"
CAMERA_SKIP_FRAMES = 5        # lets auto-exposure settle
CAMERA_PALETTE = None         # e.g. "YUYV" or "MJPEG" if fswebcam complains about the format
SNAPSHOT_ON_GRANTED = False   # True = also photograph every successful entry
SNAPSHOT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "snapshots")

# ----------------------------------------------------------------------------
# OFFLINE QUEUE (readings and snapshots wait here while the server is down)
# ----------------------------------------------------------------------------
QUEUE_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "offline_queue.db")
LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "device.log")
