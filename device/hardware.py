"""
hardware.py - everything that touches GPIO, the RC522 reader, the DHT sensor
and the camera.

Notes learned from the test scripts:
  * test_rfid.py (mfrc522 / SimpleMFRC522) lets the library pick the pin
    numbering mode, while the other tests use BCM. To avoid
    "a different mode has already been set", the RFID reader is created FIRST
    and every other pin is then translated to whatever mode is active (P()).
  * The DHT22 is read in a separate process (dht_worker.py). Its library
    (Blinka) sets its own GPIO mode, which could clash with RPi.GPIO here.
    A separate process also keeps the rest of the system running if the
    sensor is unplugged or the library crashes.
"""
import json
import logging
import os
import subprocess
import sys
import threading
import time

import RPi.GPIO as GPIO

import config as cfg

log = logging.getLogger("hardware")

_BCM_TO_BOARD = {2: 3, 3: 5, 4: 7, 5: 29, 6: 31, 12: 32, 13: 33, 16: 36, 17: 11,
                 18: 12, 19: 35, 20: 38, 21: 40, 22: 15, 23: 16, 24: 18, 26: 37, 27: 13}


def P(bcm):
    """Translate a BCM pin number to the pin numbering mode currently active."""
    return bcm if GPIO.getmode() == GPIO.BCM else _BCM_TO_BOARD[bcm]


# ----------------------------------------------------------------------------
class RfidReader:
    """RC522 over SPI. Returns the same card ID number test_rfid.py prints."""

    def __init__(self):
        from mfrc522 import MFRC522          # created first, see module note
        self.reader = MFRC522()

    def read_uid(self):
        r = self.reader
        status, _ = r.MFRC522_Request(r.PICC_REQIDL)
        if status != r.MI_OK:
            return None
        status, uid = r.MFRC522_Anticoll()
        if status != r.MI_OK or not uid:
            return None
        n = 0
        for i in range(0, 5):                # same maths as SimpleMFRC522.uid_to_num
            n = n * 256 + uid[i]
        return str(n)


# ----------------------------------------------------------------------------
class Buzzer:
    """Buzzer indicators on GPIO23; passive devices are driven with PWM."""

    def __init__(self):
        self._lock = threading.Lock()
        self._pin = P(cfg.PIN_BUZZER)
        GPIO.setup(self._pin, GPIO.OUT, initial=GPIO.LOW)
        self._pwm = None
        if cfg.BUZZER_TYPE == "passive":
            self._pwm = GPIO.PWM(self._pin, cfg.BUZZER_FREQ_HZ)
            self._pwm.start(0)

    def _on(self):
        if self._pwm:
            self._pwm.ChangeDutyCycle(50)
        else:
            GPIO.output(self._pin, GPIO.HIGH)

    def _off(self):
        if self._pwm:
            self._pwm.ChangeDutyCycle(0)
        else:
            GPIO.output(self._pin, GPIO.LOW)

    def beep(self, on_ms=100, off_ms=100, count=1):
        with self._lock:
            for beep_index in range(count):
                self._on()
                time.sleep(on_ms / 1000.0)
                self._off()
                if beep_index < count - 1:
                    time.sleep(off_ms / 1000.0)

    # ---- patterns -----------------------------------------------------------
    def boot(self):          self.beep(80, 80, 2)          # 2 short  : device started
    def tick(self):          self.beep(25)                 # tiny tick: key pressed
    def card_ok(self):       self.beep(200)                # 1 medium : card known, type the PIN
    def card_unknown(self):  self.beep(80, 80, 3)          # 3 short  : unknown card
    def pin_ok(self):        self.beep(120, 100, 2)        # 2 medium : access granted / door closed
    def pin_wrong(self):     self.beep(700)                # 1 long   : wrong PIN
    def lockout(self):       self.beep(150, 100, 5)        # 5 beeps  : locked out
    def error(self):         self.beep(400, 200, 2)        # 2 long   : server unreachable
    def alarm(self):         self.beep(120, 120, 2)        # double   : gas / heat / humidity alarm

    def cleanup(self):
        try:
            self._off()
            if self._pwm:
                self._pwm.stop()
        except Exception:
            pass


# ----------------------------------------------------------------------------
class Relay:
    """Fan relay on GPIO17."""

    def __init__(self):
        self._pin = P(cfg.PIN_RELAY)
        self.is_on = False
        GPIO.setup(self._pin, GPIO.OUT, initial=self._level(False))

    @staticmethod
    def _level(on):
        return GPIO.HIGH if (on == cfg.RELAY_ACTIVE_HIGH) else GPIO.LOW

    def set(self, on):
        on = bool(on)
        if on != self.is_on:
            GPIO.output(self._pin, self._level(on))
            self.is_on = on
            log.info("Fan relay %s", "ON" if on else "OFF")


# ----------------------------------------------------------------------------
class Door:
    """Servo lock on GPIO22, same duty-cycle maths as test_servo.py."""

    def __init__(self):
        self._pin = P(cfg.PIN_SERVO)
        GPIO.setup(self._pin, GPIO.OUT)
        self._pwm = GPIO.PWM(self._pin, 50)
        self._pwm.start(0)
        self.is_open = False
        self._move(cfg.SERVO_LOCKED_ANGLE)

    def _move(self, angle):
        self._pwm.ChangeDutyCycle(2.5 + angle / 18.0)
        time.sleep(0.8)
        self._pwm.ChangeDutyCycle(0)          # stop the signal so the servo does not jitter

    def open(self):
        self._move(cfg.SERVO_OPEN_ANGLE)
        self.is_open = True
        log.info("Door OPEN")

    def close(self):
        self._move(cfg.SERVO_LOCKED_ANGLE)
        self.is_open = False
        log.info("Door CLOSED")

    def cleanup(self):
        try:
            self._pwm.stop()
        except Exception:
            pass


# ----------------------------------------------------------------------------
class Keypad:
    """3x4 keypad, same scan method as test_keypad.py (columns driven LOW, rows read)."""

    def __init__(self):
        self.rows = [P(p) for p in cfg.KEYPAD_ROWS]
        self.cols = [P(p) for p in cfg.KEYPAD_COLS]
        for r in self.rows:
            GPIO.setup(r, GPIO.IN, pull_up_down=GPIO.PUD_UP)
        for c in self.cols:
            GPIO.setup(c, GPIO.OUT, initial=GPIO.HIGH)
        self._last = None

    def _scan(self):
        for ci, c in enumerate(self.cols):
            GPIO.output(c, GPIO.LOW)
            time.sleep(0.005)
            for ri, r in enumerate(self.rows):
                if GPIO.input(r) == GPIO.LOW:
                    GPIO.output(c, GPIO.HIGH)
                    return cfg.KEYPAD_KEYS[ri][ci]
            GPIO.output(c, GPIO.HIGH)
        return None

    def get_key(self):
        """Returns a key once per press, otherwise None."""
        k = self._scan()
        if k is not None and k != self._last:
            self._last = k
            return k
        if k is None:
            self._last = None
        return None


# ----------------------------------------------------------------------------
class GasSensor:
    """MQ3 digital output on GPIO27 (your test: LOW = threshold detected)."""

    def __init__(self):
        self._pin = P(cfg.PIN_MQ3_DO)
        GPIO.setup(self._pin, GPIO.IN)

    def present(self):
        votes = 0
        try:
            for _ in range(3):                # 3 quick samples, majority wins
                level = GPIO.input(self._pin)
                if (level == GPIO.LOW) == cfg.MQ3_ACTIVE_LOW:
                    votes += 1
                time.sleep(0.02)
        except Exception as exc:
            log.warning("Gas sensor read failed: %s", exc)
            return None
        return votes >= 2


# ----------------------------------------------------------------------------
class DhtMonitor:
    """Runs dht_worker.py in a separate process and keeps the latest reading."""

    def __init__(self):
        self._lock = threading.Lock()
        self._latest = {"ok": False, "ts": 0.0, "temperature": None, "humidity": None}
        self._stop = threading.Event()
        self._proc = None
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()

    def _spawn(self):
        worker = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dht_worker.py")
        return subprocess.Popen(
            [sys.executable, worker, "--pin", str(cfg.PIN_DHT), "--type", cfg.DHT_TYPE,
             "--interval", str(cfg.DHT_INTERVAL_S)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)

    def _run(self):
        while not self._stop.is_set():
            try:
                self._proc = self._spawn()
            except Exception as exc:
                log.error("Could not start DHT worker: %s", exc)
                time.sleep(5)
                continue
            for line in self._proc.stdout:
                try:
                    data = json.loads(line)
                except ValueError:
                    continue
                data["ts"] = time.time()
                with self._lock:
                    self._latest = data
                if self._stop.is_set():
                    break
            if not self._stop.is_set():
                log.warning("DHT worker stopped; restarting in 5 s")
                time.sleep(5)

    def latest(self):
        """(temperature, humidity), or (None, None) if the sensor is offline/stale."""
        with self._lock:
            d = dict(self._latest)
        fresh = (time.time() - d.get("ts", 0)) <= cfg.DHT_STALE_S
        if d.get("ok") and fresh:
            return d.get("temperature"), d.get("humidity")
        return None, None

    def stop(self):
        self._stop.set()
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()


# ----------------------------------------------------------------------------
def capture_snapshot(reason):
    """Takes a photo with fswebcam. Returns the file path, or None if the camera fails."""
    os.makedirs(cfg.SNAPSHOT_DIR, exist_ok=True)
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in reason)
    path = os.path.join(cfg.SNAPSHOT_DIR, f"{int(time.time())}_{safe}.jpg")
    cmd = ["fswebcam", "-d", cfg.CAMERA_DEVICE, "-r", cfg.CAMERA_RESOLUTION,
           "-S", str(cfg.CAMERA_SKIP_FRAMES), "--no-banner"]
    if cfg.CAMERA_PALETTE:
        cmd += ["-p", cfg.CAMERA_PALETTE]
    cmd.append(path)
    try:
        subprocess.run(cmd, check=True, timeout=20,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as exc:                 # camera unplugged, busy, fswebcam missing...
        log.warning("Camera capture failed: %s", exc)
        return None
    return path if os.path.exists(path) and os.path.getsize(path) > 0 else None


# ----------------------------------------------------------------------------
class Hardware:
    def __init__(self):
        GPIO.setwarnings(False)
        self.rfid = RfidReader()              # FIRST: it chooses the pin mode, see module note
        if GPIO.getmode() is None:
            GPIO.setmode(GPIO.BCM)
        self.buzzer = Buzzer()
        self.relay = Relay()
        self.door = Door()
        self.keypad = Keypad()
        self.gas = GasSensor()
        self.dht = DhtMonitor()

    def cleanup(self):
        self.dht.stop()
        self.buzzer.cleanup()
        self.door.cleanup()
        GPIO.cleanup()
