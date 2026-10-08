const router = require('express').Router();
const pool = require('../db');
const { requireDevice, requireLogin, readLimit } = require('../middleware');

const methods = ['rfid', 'pin'];
const results = ['granted', 'denied'];

router.post('/access', requireDevice, async (req, res) => {
  const { method, result, reason = null, user_id = null, card_id = null, snapshot_id = null } = req.body;
  if (!methods.includes(method) || !results.includes(result) ||
      (reason !== null && (typeof reason !== 'string' || reason.length > 50)) ||
      [user_id, card_id, snapshot_id].some(id => id !== null && (!Number.isInteger(id) || id < 1 || id > 2147483647))) {
    return res.status(400).json({ success: false, message: 'Invalid access attempt fields' });
  }
  await pool.query(`INSERT INTO access_logs (device_id, user_id, card_id, method, result, reason, snapshot_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  [req.deviceId, user_id, card_id, method, result, reason, snapshot_id]);
  res.status(201).json({ success: true, message: 'Access attempt stored' });
});

router.get('/access', requireLogin, readLimit, listAccess);
router.get('/access-logs', requireLogin, readLimit, listAccess);

async function listAccess(req, res) {
  const values = [req.limit];
  const filter = typeof req.query.device_uid === 'string' && req.query.device_uid.trim()
    ? (values.push(req.query.device_uid.trim()), 'AND d.device_uid = $2') : '';
  const { rows } = await pool.query(`SELECT a.id, d.device_uid, a.created_at, a.method, a.result, a.reason,
    a.user_id, u.name AS user_name, a.card_id, a.snapshot_id
    FROM access_logs a JOIN devices d ON d.id = a.device_id
    LEFT JOIN users u ON u.id = a.user_id WHERE TRUE ${filter}
    ORDER BY a.created_at DESC, a.id DESC LIMIT $1`, values);
  res.json(rows);
}

module.exports = router;
