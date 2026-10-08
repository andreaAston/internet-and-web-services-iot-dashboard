"""
api_client.py - talks to the Express backend and keeps an offline queue.

Routes your backend already has:
  POST /api/telemetry   JSON, X-API-Key   {device_uid, temperature, humidity, gas_present, fan_on}
  POST /api/access      JSON, X-API-Key   {device_uid, method, result, reason, user_id, card_id}
  POST /api/snapshots   multipart, X-API-Key   fields device_uid, reason, image
  POST /api/login       JSON              {username, password} -> {token}

Routes added by backend/deviceAccess.js (REQUIRED - the Pi cannot decide
who may enter, or store a new card + PIN, without them):
    POST /api/device/verify-access {device_uid, card_uid, pin} -> {granted, user_id, card_id, name}
  POST /api/device/verify-pin    {device_uid, user_id, pin}  -> {granted, reason}
  POST /api/enroll               (admin JWT) {name, pin, card_uid}

Rules:
    * Entry requires both the enrolled card and PIN, in either input order. Access
        decisions are never cached or guessed; server failure means denied.
  * Telemetry, access events and snapshots wait in a small SQLite file when the
    server is down and are re-sent in order when it comes back.
  * The PIN is only sent for checking or enrolment. It is never logged.
"""
import json
import logging
import os
import sqlite3
import threading
import time

import requests

import config as cfg

log = logging.getLogger("api")


class OfflineQueue:
    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        with self._conn() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS queue (
                           id INTEGER PRIMARY KEY AUTOINCREMENT,
                           kind TEXT NOT NULL,
                           endpoint TEXT NOT NULL,
                           payload TEXT NOT NULL,
                           created_at REAL NOT NULL)""")

    def _conn(self):
        return sqlite3.connect(self.path, timeout=10)

    def add(self, kind, endpoint, payload):
        with self._lock, self._conn() as c:
            c.execute("INSERT INTO queue (kind, endpoint, payload, created_at) VALUES (?,?,?,?)",
                      (kind, endpoint, json.dumps(payload), time.time()))

    def pending(self, limit=50):
        with self._lock, self._conn() as c:
            return c.execute("SELECT id, kind, endpoint, payload FROM queue ORDER BY id LIMIT ?",
                             (limit,)).fetchall()

    def delete(self, row_id):
        with self._lock, self._conn() as c:
            c.execute("DELETE FROM queue WHERE id = ?", (row_id,))

    def count(self):
        with self._lock, self._conn() as c:
            return c.execute("SELECT COUNT(*) FROM queue").fetchone()[0]


class ApiClient:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({cfg.API_KEY_HEADER: cfg.DEVICE_API_KEY})
        self.queue = OfflineQueue(cfg.QUEUE_DB)

    # ---- low level -----------------------------------------------------------------
    @staticmethod
    def _url(path):
        return cfg.SERVER_URL.rstrip("/") + path

    def _post_json(self, path, body, headers=None):
        return self.session.post(self._url(path), json=body, headers=headers,
                                 timeout=cfg.REQUEST_TIMEOUT_S)

    def _post_file(self, path, file_path, fields):
        with open(file_path, "rb") as fh:
            return self.session.post(
                self._url(path), data=fields,
                files={cfg.SNAPSHOT_FIELD: (os.path.basename(file_path), fh, "image/jpeg")},
                timeout=cfg.REQUEST_TIMEOUT_S * 3)

    @staticmethod
    def _json(resp):
        try:
            data = resp.json()
            return data if isinstance(data, dict) else {}
        except ValueError:
            return {}

    # ---- card and PIN checks (fail secure) ---------------------------------------------
    def _verify_call(self, path, body):
        """Returns (status_code, data), or None if the server is unreachable or failed."""
        try:
            resp = self._post_json(path, body)
        except requests.RequestException as exc:
            log.warning("Server unreachable for access check: %s", exc)
            return None
        if resp.status_code >= 500:
            log.error("Server error %s during access check", resp.status_code)
            return None
        if resp.status_code in (401, 403):
            log.warning("Server answered %s. If this happens for correct cards/PINs, "
                        "check DEVICE_API_KEY and DEVICE_UID in .env", resp.status_code)
        if resp.status_code == 404:
            log.error("Route not found (404): is backend/deviceAccess.js mounted in server.js?")
        return resp.status_code, self._json(resp)

    def verify_card(self, card_uid):
        """{'known', 'user_id', 'card_id', 'name'} or None when the server is unreachable."""
        out = self._verify_call(cfg.ENDPOINTS["verify_card"],
                                {"device_uid": cfg.DEVICE_UID, "card_uid": card_uid})
        if out is None:
            return None
        status, data = out
        return {"known": status < 300 and data.get("known") is True,
                "user_id": data.get("user_id"), "card_id": data.get("card_id"),
                "name": data.get("name")}

    def verify_access(self, card_uid, pin):
        """Verify the card and PIN together; neither factor alone grants entry."""
        out = self._verify_call(cfg.ENDPOINTS["verify_access"],
                                {"device_uid": cfg.DEVICE_UID, "card_uid": card_uid, "pin": pin})
        if out is None:
            return None
        status, data = out
        return {"granted": status < 300 and data.get("granted") is True,
                "reason": data.get("reason", "verification_failed"),
                "user_id": data.get("user_id"), "card_id": data.get("card_id"),
                "name": data.get("name")}

    def verify_pin(self, user_id, pin):
        """{'granted', 'reason'} or None when the server is unreachable."""
        out = self._verify_call(cfg.ENDPOINTS["verify_pin"],
                                {"device_uid": cfg.DEVICE_UID, "user_id": user_id, "pin": pin})
        if out is None:
            return None
        status, data = out
        return {"granted": status < 300 and data.get("granted") is True,
                "reason": data.get("reason")}

    # ---- queued sends (telemetry, access events, snapshots) -------------------------------
    def _send_json(self, path, payload, what):
        try:
            resp = self._post_json(path, payload)
        except requests.RequestException:
            self.queue.add("json", path, payload)
            log.warning("Server offline: %s queued (%d waiting)", what, self.queue.count())
            return False
        if resp.status_code >= 500:
            self.queue.add("json", path, payload)
            log.warning("Server error %s: %s queued", resp.status_code, what)
            return False
        if resp.status_code >= 400:
            log.error("%s rejected (%s): %s", what, resp.status_code, resp.text[:200])
            return False
        return True

    def send_telemetry(self, readings):
        payload = {
            "device_uid": cfg.DEVICE_UID,
            "temperature": readings.get("temperature"),
            "humidity": readings.get("humidity"),
            "gas_present": readings.get("gas_present"),
            "fan_on": readings.get("fan_on"),
        }
        return self._send_json(cfg.ENDPOINTS["telemetry"], payload, "telemetry")

    def send_access(self, method, result, reason=None, user_id=None, card_id=None):
        """Logs an RFID/PIN event. Runs in a thread so beeps and keys are never delayed."""
        payload = {"device_uid": cfg.DEVICE_UID, "method": method, "result": result}
        if reason is not None:
            payload["reason"] = reason
        if user_id is not None:
            payload["user_id"] = user_id
        if card_id is not None:
            payload["card_id"] = card_id
        threading.Thread(target=self._send_json,
                         args=(cfg.ENDPOINTS["access"], payload, "access event"),
                         daemon=True).start()

    def send_snapshot(self, file_path, reason):
        path = cfg.ENDPOINTS["snapshots"]
        fields = {"device_uid": cfg.DEVICE_UID, "reason": reason}
        try:
            resp = self._post_file(path, file_path, fields)
        except requests.RequestException:
            self.queue.add("file", path, {"file": file_path, "fields": fields})
            log.warning("Server offline: snapshot queued")
            return False
        if resp.status_code >= 500:
            self.queue.add("file", path, {"file": file_path, "fields": fields})
            return False
        if resp.status_code >= 400:
            log.error("Snapshot rejected (%s): %s", resp.status_code, resp.text[:200])
            return False
        return True

    def flush_queue(self):
        """Re-sends queued items in order. Stops at the first sign the server is still down."""
        for row_id, kind, endpoint, payload in self.queue.pending():
            data = json.loads(payload)
            try:
                if kind == "json":
                    resp = self._post_json(endpoint, data)
                else:
                    if not os.path.exists(data["file"]):
                        self.queue.delete(row_id)
                        continue
                    resp = self._post_file(endpoint, data["file"], data.get("fields", {}))
            except requests.RequestException:
                return
            if resp.status_code >= 500:
                return
            if resp.status_code >= 400:
                log.error("Queued item %s dropped (server said %s)", row_id, resp.status_code)
            self.queue.delete(row_id)

    # ---- enrolment (admin login, not the device key) ---------------------------------------
    @staticmethod
    def _check(resp):
        if resp.status_code >= 400:
            raise RuntimeError("%s: %s" % (resp.status_code, resp.text[:200]))

    def login(self, username, password):
        resp = self._post_json(cfg.ENDPOINTS["login"], {"username": username, "password": password})
        self._check(resp)
        token = self._json(resp).get("token")
        if not token:
            raise RuntimeError("Login succeeded but no token was returned")
        return token

    def enroll(self, token, name, pin, card_uid):
        """Stores a person: the server saves name + bcrypt(PIN) in users and sha256(card ID) in cards."""
        resp = self._post_json(cfg.ENDPOINTS["enroll"],
                               {"name": name, "pin": pin, "card_uid": card_uid},
                               headers={"Authorization": f"Bearer {token}"})
        self._check(resp)
        return self._json(resp)
