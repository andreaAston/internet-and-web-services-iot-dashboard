const router = require('express').Router();
const pool = require('../db');
const { requireLogin } = require('../middleware');

router.get('/devices', requireLogin, async (req, res) => {
  const { rows } = await pool.query(`SELECT id, device_uid, name, location, last_seen,
    COALESCE(last_seen > NOW() - INTERVAL '2 minutes', FALSE) AS device_online
    FROM devices ORDER BY name, id`);
  res.json(rows);
});

module.exports = router;
