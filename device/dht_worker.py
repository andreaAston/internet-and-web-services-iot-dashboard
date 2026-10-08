"""
dht_worker.py - reads the DHT sensor in its own process and prints one JSON
line per reading, e.g.  {"ok": true, "temperature": 24.1, "humidity": 55.2}
If the sensor is unplugged it prints {"ok": false, "error": "..."} instead of
crashing, so the main program keeps running (Resilience Challenge).
Started automatically by hardware.DhtMonitor.
"""
import argparse
import json
import time

import adafruit_dht
import board


def make_sensor(pin, kind):
    cls = adafruit_dht.DHT22 if kind.upper() == "DHT22" else adafruit_dht.DHT11
    return cls(pin, use_pulseio=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pin", type=int, default=4)
    ap.add_argument("--type", default="DHT22")
    ap.add_argument("--interval", type=float, default=3.0)
    args = ap.parse_args()

    pin = getattr(board, f"D{args.pin}")
    sensor = make_sensor(pin, args.type)

    while True:
        try:
            t = sensor.temperature
            h = sensor.humidity
            if t is None or h is None:
                raise RuntimeError("no data")
            if not (-40 <= t <= 80 and 0 <= h <= 100):
                raise RuntimeError("value out of range")
            out = {"ok": True, "temperature": round(float(t), 1), "humidity": round(float(h), 1)}
        except RuntimeError as exc:           # normal for DHT sensors: just try again
            out = {"ok": False, "error": str(exc)}
        except Exception as exc:              # serious error: reset the sensor object
            print(json.dumps({"ok": False, "error": repr(exc)}), flush=True)
            try:
                sensor.exit()
                time.sleep(2)
                sensor = make_sensor(pin, args.type)
            except Exception:
                pass
            continue
        print(json.dumps(out), flush=True)
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
