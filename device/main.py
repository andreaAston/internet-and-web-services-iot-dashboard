"""
main.py - Raspberry Pi firmware: smart access + environment monitor.

Run (inside the venv):    source ~/rfid-venv/bin/activate
                          python main.py

The program has TWO STEPS, at the bottom of this file in main():

  STEP 1 - ENROLMENT  (run once)
      Registers people. For each person: the card ID is read from the RC522 reader,
      the PIN is typed on the keypad (twice), and both are stored in the database
      through the backend (card ID hashed with SHA-256, PIN hashed with bcrypt).
      When everyone is registered, COMMENT OUT the "run_enrolment(hw, api)" line in
      main(). From then on the firmware starts straight in normal operation.

  STEP 2 - NORMAL OPERATION
        1. Enter the PIN and press # or pause briefly, then tap the card; or tap
            the card and enter the PIN, then press # or pause briefly. The server
            verifies both factors together.
        2. Both valid -> door (servo) opens to 90 degrees. Either invalid -> denied,
            photo taken. 3 failures = 30 s lockout.
      3. With the door open, enter the same person's PIN + # again -> door closes (0 degrees).
      4. Every 5 s the DHT temperature/humidity and the MQ3 gas state are sent to the
         server. Gas, heat or humidity over the limit switches the fan relay on and gives
         a double beep.
      If the server is down: access is denied (fail secure) and telemetry, access events
      and photos are queued and sent when it returns. If the camera or the DHT is
      unplugged the rest keeps working.

CAMERA LOGIC
      A photo is taken with fswebcam when an attempt FAILS (unknown card, wrong PIN,
      including the attempt that causes a lockout). It is uploaded to /api/snapshots with
      the reason; the backend stores the file and its path, and the dashboard shows the
      latest one. Set SNAPSHOT_ON_GRANTED = True in config.py to photograph successful
      entries too. If the camera fails the photo is skipped and nothing else is affected.

BUZZER (the only indicator, GPIO23)
      2 short = booted | tick = key pressed | 1 medium = card OK | 3 short = unknown card
      2 medium = PIN OK / door closed | 1 long = wrong PIN | 5 = lockout
      2 long = server unreachable | double beep (every 15 s) = environment alarm
"""
import getpass
import logging
import sys
import threading
import time

import config as cfg
from api_client import ApiClient
from hardware import Hardware, capture_snapshot

log = logging.getLogger("main")

IDLE, WAIT_PIN, WAIT_CARD, OPEN, LOCKED_OUT = "IDLE", "WAIT_PIN", "WAIT_CARD", "OPEN", "LOCKED_OUT"


# =============================================================================
# STEP 2 - NORMAL OPERATION
# =============================================================================
class Controller:
    def __init__(self, hw, api):
        self.hw = hw
        self.api = api
        self.state = IDLE
        self.state_since = time.time()
        self.card_uid = None
        self.user_id = None
        self.card_id = None
        self.pin = ""
        self.pin_last_input_at = None
        self.fails = 0
        self.lockout_until = 0.0
        self.stop = threading.Event()

    def clear_session(self):
        self.card_uid = self.user_id = self.card_id = None
        self.pin = ""
        self.pin_last_input_at = None

    def set_state(self, state):
        self.state = state
        self.state_since = time.time()
        log.info("State -> %s", state)

    # ---- photos ----------------------------------------------------------------------
    def snapshot_async(self, reason):
        threading.Thread(target=self._snapshot, args=(reason,), daemon=True).start()

    def _snapshot(self, reason):
        path = capture_snapshot(reason)
        if path:
            self.api.send_snapshot(path, reason)
        else:
            log.warning("No snapshot for '%s' (camera unavailable)", reason)

    # ---- failure handling ------------------------------------------------------------
    def register_failure(self, reason):
        self.fails += 1
        log.warning("DENIED (%s). Failed attempts: %d/%d", reason, self.fails, cfg.MAX_FAILS)
        if reason == "unknown_card":
            self.hw.buzzer.card_unknown()
        else:
            self.hw.buzzer.pin_wrong()
        self.snapshot_async(reason)
        self.clear_session()
        if self.fails >= cfg.MAX_FAILS:
            self.lockout_until = time.time() + cfg.LOCKOUT_S
            self.set_state(LOCKED_OUT)
            log.warning("LOCKOUT for %d s", cfg.LOCKOUT_S)
            self.hw.buzzer.lockout()
        else:
            self.set_state(IDLE)

    # ---- card ------------------------------------------------------------------------
    def on_card(self, uid):
        if self.state not in (IDLE, WAIT_CARD):
            return
        log.info("Card scanned: %s", uid)
        self.card_uid = uid
        if len(self.pin) >= cfg.PIN_MIN_LEN:
            self.verify_access("rfid")
        else:
            self.hw.buzzer.tick()
            self.set_state(WAIT_PIN)

    # ---- keypad ----------------------------------------------------------------------
    def on_key(self, key):
        if self.state == IDLE and key.isdigit():
            self.set_state(WAIT_CARD)
        if self.state not in (WAIT_PIN, WAIT_CARD, OPEN):
            return
        self.hw.buzzer.tick()
        if key.isdigit():
            if len(self.pin) < cfg.PIN_MAX_LEN:
                self.pin += key
                self.pin_last_input_at = time.monotonic()
        elif key == "*":
            self.pin = ""
            self.pin_last_input_at = None
        elif key == "#":
            self.submit_pin()
            return
        if self.state in (WAIT_PIN, WAIT_CARD):
            self.state_since = time.time()    # typing keeps the PIN window open

    def submit_pin(self):
        self.pin_last_input_at = None
        if self.state in (WAIT_PIN, WAIT_CARD) and len(self.pin) < cfg.PIN_MIN_LEN:
            log.info("PIN too short (%d digits)", len(self.pin))
            self.pin = ""
            self.hw.buzzer.pin_wrong()
            return
        if self.state == WAIT_CARD:
            log.info("PIN entered; scan the card to verify both factors")
            self.state_since = time.time()
            return
        if self.state == WAIT_PIN:
            self.verify_access("pin")
            return

        pin, self.pin = self.pin, ""
        uid, cid = self.user_id, self.card_id
        result = self.api.verify_pin(uid, pin)             # the PIN itself is never logged
        if result is None:
            self.hw.buzzer.error()
            self.api.send_access("pin", "denied", "server_unreachable", uid, cid)
            if self.state == WAIT_PIN:
                self.clear_session()
                self.set_state(IDLE)
            return
        if self.state == WAIT_PIN:
            if result["granted"]:
                self.fails = 0
                self.api.send_access("rfid", "granted", "card_and_pin_authorized", uid, cid)
                self.hw.door.open()
                self.hw.buzzer.pin_ok()
                if cfg.SNAPSHOT_ON_GRANTED:
                    self.snapshot_async("granted_entry")
                self.set_state(OPEN)
            else:
                self.api.send_access("pin", "denied", result["reason"] or "wrong_pin", uid, cid)
                self.register_failure("wrong_pin")
        elif self.state == OPEN:
            if result["granted"]:
                self.api.send_access("pin", "granted", "door_closed", uid, cid)
                self.hw.door.close()
                self.hw.buzzer.pin_ok()
                self.clear_session()
                self.set_state(IDLE)
            else:
                self.api.send_access("pin", "denied", "wrong_pin_door_open", uid, cid)
                self.hw.buzzer.pin_wrong()

    def verify_access(self, final_factor):
        pin, self.pin = self.pin, ""
        result = self.api.verify_access(self.card_uid, pin)
        if result is None:
            self.hw.buzzer.error()
            self.api.send_access(final_factor, "denied", "server_unreachable")
            self.clear_session()
            self.set_state(IDLE)
            return
        if not result["granted"]:
            reason = result.get("reason") or "invalid_credentials"
            self.api.send_access(final_factor, "denied", reason)
            self.register_failure("invalid_credentials")
            return

        self.user_id = result["user_id"]
        self.card_id = result["card_id"]
        self.fails = 0
        self.api.send_access(final_factor, "granted", "card_and_pin_authorized",
                             self.user_id, self.card_id)
        self.hw.door.open()
        self.hw.buzzer.pin_ok()
        if cfg.SNAPSHOT_ON_GRANTED:
            self.snapshot_async("granted_entry")
        self.set_state(OPEN)

    # ---- main loop -------------------------------------------------------------------
    def run(self):
        self.hw.buzzer.boot()
        log.info("Ready. Tap a card.")
        while not self.stop.is_set():
            now = time.time()
            monotonic_now = time.monotonic()
            if self.state == LOCKED_OUT:
                if now >= self.lockout_until:
                    self.fails = 0
                    self.set_state(IDLE)
                else:
                    time.sleep(0.2)
                    continue
            if (self.state in (WAIT_PIN, WAIT_CARD, OPEN) and self.pin_last_input_at is not None
                    and len(self.pin) >= cfg.PIN_MIN_LEN
                    and monotonic_now - self.pin_last_input_at >= cfg.PIN_SUBMIT_IDLE_S):
                self.submit_pin()
            if self.state in (WAIT_PIN, WAIT_CARD) and now - self.state_since > cfg.PIN_TIMEOUT_S:
                log.info("PIN timeout")
                self.clear_session()
                self.set_state(IDLE)
            if self.state == OPEN and cfg.AUTO_RELOCK_S and now - self.state_since > cfg.AUTO_RELOCK_S:
                self.hw.door.close()
                self.clear_session()
                self.set_state(IDLE)
            if self.state in (IDLE, WAIT_CARD):
                uid = self.hw.rfid.read_uid()
                if uid:
                    self.on_card(uid)
                    time.sleep(cfg.CARD_COOLDOWN_S)
            key = self.hw.keypad.get_key()
            if key:
                self.on_key(key)
            time.sleep(0.03)


class SensorLoop(threading.Thread):
    """Reads DHT + MQ3 every few seconds, drives the fan relay and sends telemetry."""

    def __init__(self, hw, api, stop):
        super().__init__(daemon=True)
        self.hw, self.api, self.stop = hw, api, stop

    def run(self):
        temp_high = hum_high = False
        last_alarm_beep = 0.0
        self.stop.wait(5)                     # give the DHT worker time for a first reading
        while not self.stop.is_set():
            try:
                t, h = self.hw.dht.latest()
                gas = self.hw.gas.present()
                if t is not None:
                    if t >= cfg.FAN_ON_TEMP_C:
                        temp_high = True
                    elif t <= cfg.FAN_ON_TEMP_C - cfg.FAN_HYST_C:
                        temp_high = False
                if h is not None:
                    if h >= cfg.FAN_ON_HUMIDITY:
                        hum_high = True
                    elif h <= cfg.FAN_ON_HUMIDITY - cfg.FAN_HYST_HUMIDITY:
                        hum_high = False
                alarm = gas is True or temp_high or hum_high
                self.hw.relay.set(alarm)
                # Keep unavailable DHT readings as None; the API stores them as SQL NULL.
                payload = {"temperature": t, "humidity": h, "gas_present": gas,
                           "fan_on": self.hw.relay.is_on}
                self.api.send_telemetry(payload)
                self.api.flush_queue()
                log.info("Telemetry: %s", payload)
                if alarm and cfg.ALARM_BUZZER and time.time() - last_alarm_beep >= cfg.ALARM_BEEP_EVERY_S:
                    last_alarm_beep = time.time()
                    self.hw.buzzer.alarm()
            except Exception:
                log.exception("Sensor loop error (continuing)")
            self.stop.wait(cfg.READING_INTERVAL_S)


def run_operation(hw, api):
    hw.dht.start()
    ctrl = Controller(hw, api)
    SensorLoop(hw, api, ctrl.stop).start()
    ctrl.run()


# =============================================================================
# STEP 1 - ENROLMENT (card ID + PIN -> database)
# =============================================================================
def wait_for_card(hw, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        uid = hw.rfid.read_uid()
        if uid:
            return uid
        time.sleep(0.1)
    return None


def read_pin_on_keypad(hw, prompt):
    print(prompt + "  (digits, pause to submit, # also submits, * to clear)")
    pin = ""
    last_digit_at = None
    while True:
        key = hw.keypad.get_key()
        if key:
            hw.buzzer.tick()
            if key.isdigit() and len(pin) < cfg.PIN_MAX_LEN:
                pin += key
                last_digit_at = time.monotonic()
                print("*" * len(pin), end="\r", flush=True)
            elif key == "*":
                pin = ""
                last_digit_at = None
                print(" " * 12, end="\r", flush=True)
            elif key == "#":
                print()
                return pin
        if (len(pin) >= cfg.PIN_MIN_LEN and last_digit_at is not None
                and time.monotonic() - last_digit_at >= cfg.PIN_SUBMIT_IDLE_S):
            print()
            return pin
        time.sleep(0.03)


def ask_new_pin(hw):
    while True:
        pin1 = read_pin_on_keypad(hw, "Enter a PIN of %d-%d digits" % (cfg.PIN_MIN_LEN, cfg.PIN_MAX_LEN))
        if len(pin1) < cfg.PIN_MIN_LEN:
            print("Too short, try again.")
            hw.buzzer.pin_wrong()
            continue
        pin2 = read_pin_on_keypad(hw, "Enter the same PIN again")
        if pin1 == pin2:
            return pin1
        print("The PINs did not match, try again.")
        hw.buzzer.pin_wrong()


def run_enrolment(hw, api):
    """Registers people: card ID (from the RC522) + PIN (from the keypad) -> database.
    Needs the admin login, so the Pi's device key cannot create users."""
    print("\n=== STEP 1: ENROLMENT ===")
    username = input("Admin username (press Enter to skip enrolment): ").strip()
    if not username:
        print("Enrolment skipped.\n")
        return
    password = getpass.getpass("Admin password: ")
    try:
        token = api.login(username, password)
    except Exception as exc:
        print("Admin login failed:", exc)
        hw.buzzer.error()
        return
    print("Logged in.")

    while True:
        name = input("\nPerson's name (press Enter to finish enrolment): ").strip()
        if not name:
            break
        print("Tap this person's card on the reader (30 s)...")
        uid = wait_for_card(hw)
        if not uid:
            print("No card detected, try again.")
            continue
        hw.buzzer.card_ok()
        print("Card ID read:", uid)
        pin = ask_new_pin(hw)
        try:
            api.enroll(token, name, pin, uid)
            print("Saved to the database: %s, card %s." % (name, uid))
            hw.buzzer.pin_ok()
        except Exception as exc:
            print("Could not save:", exc)
            hw.buzzer.error()
    print("=== Enrolment finished ===\n")


# =============================================================================
def main():
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=[logging.StreamHandler(sys.stdout), logging.FileHandler(cfg.LOG_FILE)])

    if cfg.DEVICE_API_KEY in ("", cfg.DEVICE_API_KEY_PLACEHOLDER):
        print("DEVICE_API_KEY is not set. Copy .env.example to .env and put the real key in it.")
        sys.exit(1)

    hw = Hardware()
    api = ApiClient()
    try:
        # ===== STEP 1: ENROLMENT ====================================================
        # Enrollment needs an interactive terminal; systemd starts normal operation.
        if sys.stdin.isatty():
            run_enrolment(hw, api)
        else:
            log.info("No interactive terminal; skipping enrollment")
        # ============================================================================

        # ===== STEP 2: NORMAL OPERATION =============================================
        run_operation(hw, api)
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        hw.cleanup()


if __name__ == "__main__":
    main()
