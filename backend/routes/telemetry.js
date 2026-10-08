const router = require('express').Router();
const pool = require('../db');
const { requireDevice } = require('../middleware');

const highTemperature = Number(process.env.HIGH_TEMPERATURE_THRESHOLD || 30);
const highHumidity = Number(process.env.HIGH_HUMIDITY_THRESHOLD || 70);

function validateReading(body) {
  return (body.temperature === null || (Number.isFinite(body.temperature) && body.temperature >= -273.15 && body.temperature <= 1000)) &&
    (body.humidity === null || (Number.isFinite(body.humidity) && body.humidity >= 0 && body.humidity <= 100)) &&
    (body.gas_present === null || typeof body.gas_present === 'boolean') &&
    (body.fan_on === null || typeof body.fan_on === 'boolean');
}

async function updateAlert(client, deviceId, type, active, message) {
  if (active) {
    await client.query(`INSERT INTO alerts (device_id, type, message)
      SELECT $1, $2, $3 WHERE NOT EXISTS (
      SELECT 1 FROM alerts WHERE device_id = $1 AND type = $2::varchar AND resolved_at IS NULL
      )`, [deviceId, type, message]);
  } else {
    await client.query(`UPDATE alerts SET resolved_at = NOW()
      WHERE device_id = $1 AND type = $2::varchar AND resolved_at IS NULL`, [deviceId, type]);
  }
}

router.post('/telemetry', requireDevice, async (req, res) => {
  const { temperature, humidity, gas_present, fan_on } = req.body;
  if (!validateReading(req.body)) {
    return res.status(400).json({ success: false, message: 'Provide valid temperature, humidity (0–100), gas_present and fan_on values' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Locking the device row serializes alert checks for simultaneous telemetry.
    await client.query('UPDATE devices SET last_seen = NOW() WHERE id = $1', [req.deviceId]);
    await client.query(`INSERT INTO readings (device_id, temperature, humidity, gas_present, fan_on)
      VALUES ($1, $2, $3, $4, $5)`, [req.deviceId, temperature, humidity, gas_present, fan_on]);

    // Unknown readings must not clear an existing alert.
    if (temperature !== null) await updateAlert(client, req.deviceId, 'high_temperature', temperature > highTemperature,
      `Temperature above ${highTemperature} °C (${temperature.toFixed(1)} °C)`);
    if (humidity !== null) await updateAlert(client, req.deviceId, 'high_humidity', humidity > highHumidity,
      `Humidity above ${highHumidity}% (${humidity.toFixed(1)}%)`);
    if (gas_present !== null) await updateAlert(client, req.deviceId, 'gas_presence', gas_present,
      'Gas detected');
    await client.query('COMMIT');
    res.json({ success: true, message: 'Telemetry stored' });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

module.exports = router;
