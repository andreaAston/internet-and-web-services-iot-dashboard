const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const pool = require('./db');

function cookieToken(req) {
  const cookie = req.headers.cookie?.split(';').map(item => item.trim())
    .find(item => item.startsWith('smart_access_token='));
  return cookie ? decodeURIComponent(cookie.slice('smart_access_token='.length)) : null;
}

function requireLogin(req, res, next) {
  const header = req.headers.authorization?.split(' ');
  try {
    const token = header?.[0] === 'Bearer' ? header[1] : cookieToken(req);
    if (!token) throw new Error('Missing token');
    req.admin = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Login required' });
  }
}

function requirePageLogin(req, res, next) {
  try {
    const token = cookieToken(req);
    if (!token) throw new Error('Missing token');
    req.admin = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    res.redirect('/login');
  }
}

async function requireDevice(req, res, next) {
  const uid = req.body?.device_uid;
  if (typeof uid !== 'string' || !uid.trim() || uid.length > 100) {
    return res.status(400).json({ success: false, message: 'Valid device_uid required' });
  }
  const key = req.get('X-API-Key');
  if (!key) return res.status(401).json({ success: false, message: 'Device API key required' });
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  const { rows } = await pool.query(
    'SELECT id FROM devices WHERE device_uid = $1 AND api_key_hash = $2',
    [uid, hash]
  );
  if (!rows.length) return res.status(401).json({ success: false, message: 'Unknown device or invalid key' });
  req.deviceId = rows[0].id;
  next();
}

function readLimit(req, res, next) {
  const value = req.query.limit ?? '50';
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1000) {
    return res.status(400).json({ success: false, message: 'limit must be an integer from 1 to 1000' });
  }
  req.limit = Number(value);
  next();
}

module.exports = { requireLogin, requirePageLogin, cookieToken, requireDevice, readLimit };
