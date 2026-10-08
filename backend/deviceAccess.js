/**
 * backend/deviceAccess.js
 *
 * Three routes the Raspberry Pi needs that the current API does not have:
 *
 *   POST /api/device/verify-card   (X-API-Key)  { device_uid, card_uid }
 *        -> { known, user_id, card_id, name }
 *   POST /api/device/verify-pin    (X-API-Key)  { device_uid, user_id, pin }
 *        -> { granted, reason }
 *   POST /api/enroll               (admin JWT)  { name, pin, card_uid }
 *        -> 201 { ok, user_id, card_id, name }
 *
 * Security notes (good viva material):
 *   - PINs are stored as bcrypt hashes, card IDs as SHA-256 hashes.
 *   - The server decides; the Pi never holds credentials.
 *   - PIN checks are rate-limited per device + user (5 failures per minute).
 *   - Enrolment needs an admin login, not the device key, so a stolen Pi
 *     key cannot create users.
 *
 * HOW TO ADD IT (backend/server.js, after express.json() and before the 404 handler):
 *     app.use('/api', require('./deviceAccess'));
 *
 * THINGS TO CHECK / ADJUST (they depend on code I have not seen):
 *   1. DB access: `require('./db')` supplies the PostgreSQL pool.
 *   2. JWT_SECRET must be the same secret your /api/login route signs tokens with.
 *   3. The device key check assumes devices.api_key_hash = SHA-256 hex of the plain key,
 *      the same way your /api/telemetry route checks it.
 *   4. Needs a bcrypt package: `npm i bcryptjs` (or bcrypt, whichever you already use).
 */
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

let bcrypt;
try { bcrypt = require('bcrypt'); } catch (e) { bcrypt = require('bcryptjs'); }

const dbModule = require('./db');
const pool = dbModule.pool || dbModule;

const router = express.Router();
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// ---------------------------------------------------------------- device auth
async function requireDevice(req, res, next) {
  try {
    const key = req.get('x-api-key');
    const deviceUid = req.body && req.body.device_uid;
    if (!key || typeof deviceUid !== 'string') {
      return res.status(401).json({ error: 'Missing API key or device_uid' });
    }
    const { rows } = await pool.query(
      'SELECT id FROM devices WHERE device_uid = $1 AND api_key_hash = $2',
      [deviceUid, sha256(key)]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid device credentials' });
    req.device = rows[0];
    await pool.query('UPDATE devices SET last_seen = now() WHERE id = $1', [rows[0].id]);
    next();
  } catch (err) {
    console.error('requireDevice error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ----------------------------------------------------------------- admin auth
function requireAdmin(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Admin login required' });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ------------------------------------------------- PIN brute-force protection
const MAX_PIN_FAILS = 5;
const WINDOW_MS = 60 * 1000;
const failures = new Map();                    // key -> { count, resetAt }

function isBlocked(key) {
  const entry = failures.get(key);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) { failures.delete(key); return false; }
  return entry.count >= MAX_PIN_FAILS;
}
function noteFailure(key) {
  const entry = failures.get(key);
  if (!entry || Date.now() > entry.resetAt) {
    failures.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

// ------------------------------------------------------------------- routes
router.post('/device/verify-access', requireDevice, async (req, res) => {
  try {
    const { card_uid: cardUid, pin } = req.body || {};
    if (typeof cardUid !== 'string' || !cardUid.trim() || cardUid.length > 64 ||
        typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) {
      return res.status(400).json({ granted: false, reason: 'invalid_payload' });
    }

    const { rows } = await pool.query(
      `SELECT c.id AS card_id, c.user_id, u.name, u.pin_hash
         FROM cards c JOIN users u ON u.id = c.user_id
        WHERE c.uid_hash = $1 AND c.active AND u.active`,
      [sha256(cardUid.trim())]
    );
    if (!rows.length) return res.json({ granted: false, reason: 'invalid_credentials' });

    const person = rows[0];
    const failureKey = `${req.device.id}:${person.user_id}`;
    if (isBlocked(failureKey)) return res.status(429).json({ granted: false, reason: 'rate_limited' });

    const validPin = person.pin_hash && await bcrypt.compare(pin, person.pin_hash);
    if (!validPin) {
      noteFailure(failureKey);
      return res.json({ granted: false, reason: 'invalid_credentials' });
    }

    failures.delete(failureKey);
    res.json({ granted: true, reason: 'authorized', user_id: person.user_id,
      card_id: person.card_id, name: person.name });
  } catch (err) {
    console.error('verify-access error:', err);
    res.status(500).json({ granted: false, reason: 'server_error' });
  }
});

router.post('/device/verify-card', requireDevice, async (req, res) => {
  try {
    const cardUid = req.body.card_uid;
    if (typeof cardUid !== 'string' || cardUid.trim() === '' || cardUid.length > 64) {
      return res.status(400).json({ known: false, error: 'card_uid is required' });
    }
    const { rows } = await pool.query(
      `SELECT c.id AS card_id, c.user_id, u.name
         FROM cards c JOIN users u ON u.id = c.user_id
        WHERE c.uid_hash = $1 AND c.active AND u.active`,
      [sha256(cardUid.trim())]
    );
    if (rows.length === 0) return res.json({ known: false });
    res.json({ known: true, user_id: rows[0].user_id, card_id: rows[0].card_id, name: rows[0].name });
  } catch (err) {
    console.error('verify-card error:', err);
    res.status(500).json({ known: false, error: 'Server error' });
  }
});

router.post('/device/verify-pin', requireDevice, async (req, res) => {
  try {
    const { user_id: userId, pin } = req.body;
    if (!Number.isInteger(userId) || typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) {
      return res.status(400).json({ granted: false, reason: 'invalid_payload' });
    }
    const key = `${req.device.id}:${userId}`;
    if (isBlocked(key)) return res.status(429).json({ granted: false, reason: 'rate_limited' });

    const { rows } = await pool.query('SELECT pin_hash FROM users WHERE id = $1 AND active', [userId]);
    const ok = rows.length > 0 && rows[0].pin_hash && (await bcrypt.compare(pin, rows[0].pin_hash));
    if (!ok) {
      noteFailure(key);
      return res.json({ granted: false, reason: 'wrong_pin' });
    }
    failures.delete(key);
    res.json({ granted: true, reason: 'authorized' });
  } catch (err) {
    console.error('verify-pin error:', err);
    res.status(500).json({ granted: false, error: 'Server error' });
  }
});

router.post('/enroll', requireAdmin, async (req, res) => {
  try {
    const { name, pin, card_uid: cardUid } = req.body || {};
    if (typeof name !== 'string' || name.trim() === '' || name.length > 100) {
      return res.status(400).json({ error: 'name is required (max 100 characters)' });
    }
    if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) {
      return res.status(400).json({ error: 'pin must be 4 to 8 digits' });
    }
    if (typeof cardUid !== 'string' || cardUid.trim() === '' || cardUid.length > 64) {
      return res.status(400).json({ error: 'card_uid is required' });
    }
    const pinHash = await bcrypt.hash(pin, 10);
    const uidHash = sha256(cardUid.trim());

    // One statement = one transaction: if the card already exists, the user is not created either.
    const { rows } = await pool.query(
      `WITH new_user AS (
         INSERT INTO users (name, pin_hash) VALUES ($1, $2) RETURNING id
       )
       INSERT INTO cards (user_id, uid_hash, label)
       SELECT id, $3::char(64), $4::varchar FROM new_user
       RETURNING id AS card_id, user_id`,
      [name.trim(), pinHash, uidHash, 'RFID card']
    );
    res.status(201).json({ ok: true, user_id: rows[0].user_id, card_id: rows[0].card_id, name: name.trim() });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This card is already registered' });
    console.error('enroll error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
