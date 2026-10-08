const router = require('express').Router();
const pool = require('../db');
const { requireLogin, readLimit } = require('../middleware');
router.use(requireLogin);

async function current(req, res) {
  const values = [];
  let deviceFilter = '';
  if (typeof req.query.device_uid === 'string' && req.query.device_uid.trim()) {
    values.push(req.query.device_uid.trim());
    deviceFilter = 'WHERE d.device_uid = $1';
  }
  const { rows } = await pool.query(`SELECT r.temperature, r.humidity,
    CASE WHEN r.gas_present THEN 'detected' WHEN r.gas_present = FALSE THEN 'safe' END AS gas_status,
    CASE WHEN r.fan_on THEN 'on' WHEN r.fan_on = FALSE THEN 'off' END AS fan_status,
    COALESCE(d.last_seen > NOW() - INTERVAL '2 minutes', FALSE) AS device_online,
    d.last_seen
    FROM devices d LEFT JOIN LATERAL (
      SELECT temperature, humidity, gas_present, fan_on FROM readings
      WHERE device_id = d.id ORDER BY recorded_at DESC, id DESC LIMIT 1
    ) r ON TRUE ${deviceFilter} ORDER BY d.last_seen DESC NULLS LAST, d.id LIMIT 1`, values);
  if (!rows.length) return res.status(404).json({ success: false, message: 'Device not found' });
  res.json(rows[0]);
}

router.get('/dashboard', current);
router.get('/dashboard/current', current);

router.get('/readings/summary', async (req, res) => {
  const hours = Number(req.query.hours ?? 1);
  if (![1, 6, 24].includes(hours)) {
    return res.status(400).json({ success: false, message: 'hours must be 1, 6 or 24' });
  }

  const bucketSeconds = hours === 1 ? 300 : hours === 6 ? 900 : 3600;
  const values = [hours, bucketSeconds];
  const filter = typeof req.query.device_uid === 'string' && req.query.device_uid.trim()
    ? (values.push(req.query.device_uid.trim()), 'AND d.device_uid = $3') : '';
  const { rows } = await pool.query(`SELECT d.device_uid,
      TO_TIMESTAMP((FLOOR(EXTRACT(EPOCH FROM r.recorded_at) / $2) * $2)::double precision) AS bucket_at,
      AVG(r.temperature)::float AS temperature,
      AVG(r.humidity)::float AS humidity,
      COUNT(*)::int AS sample_count
    FROM readings r JOIN devices d ON d.id = r.device_id
    WHERE r.recorded_at >= NOW() - ($1 * INTERVAL '1 hour') ${filter}
    GROUP BY d.device_uid, 2
    ORDER BY 2`, values);
  res.json(rows);
});

router.get('/readings', readLimit, async (req, res) => {
  const values = [req.limit];
  const filter = typeof req.query.device_uid === 'string' && req.query.device_uid.trim()
    ? (values.push(req.query.device_uid.trim()), 'AND d.device_uid = $2') : '';
  const { rows } = await pool.query(`SELECT r.temperature, r.humidity, r.recorded_at, d.device_uid
    FROM readings r JOIN devices d ON d.id = r.device_id WHERE TRUE ${filter}
    ORDER BY r.recorded_at DESC, r.id DESC LIMIT $1`, values);
  res.json(rows.reverse());
});

router.get('/alerts', readLimit, async (req, res) => {
  const values = [req.limit];
  const filter = typeof req.query.device_uid === 'string' && req.query.device_uid.trim()
    ? (values.push(req.query.device_uid.trim()), 'AND d.device_uid = $2') : '';
  const { rows } = await pool.query(`SELECT a.id, a.type, a.message, a.created_at,
    a.resolved_at, CASE WHEN a.resolved_at IS NULL THEN 'Active' ELSE 'Cleared' END AS status,
    d.device_uid, d.name AS device_name
    FROM alerts a JOIN devices d ON d.id = a.device_id WHERE TRUE ${filter}
    ORDER BY a.created_at DESC, a.id DESC LIMIT $1`, values);
  res.json(rows);
});

module.exports = router;
