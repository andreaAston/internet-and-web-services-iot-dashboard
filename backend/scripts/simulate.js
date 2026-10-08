// Local demo data only. Never targets the real room or changes its records.
const crypto = require('node:crypto');
const pool = require('../db');
const uid = 'simulated-room-pi';
const once = process.argv.includes('--once');
let timer;
let stopping = false;

async function writeSample() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`INSERT INTO devices (device_uid, name, api_key_hash)
      VALUES ($1, 'Room 2', $2)
      ON CONFLICT (device_uid) DO UPDATE SET name = 'Room 2', location = 'Room 2', last_seen = NOW()
      RETURNING id`, [uid, crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex')]);
    const id = rows[0].id;
    // A repeating three-minute cycle shows normal readings, alerts, and recovery.
    const phase = Date.now() / 1000 / 180 * Math.PI * 2;
    const temperature = Number((27 + 6 * Math.sin(phase)).toFixed(1));
    const humidity = Number((60 + 15 * Math.sin(phase)).toFixed(1));
    const gas = Math.sin(phase) > 0.9;
    const fan = temperature > 28 || gas;
    await client.query('UPDATE devices SET last_seen = NOW() WHERE id = $1', [id]);
    await client.query(`INSERT INTO readings (device_id, temperature, humidity, gas_present, fan_on)
      VALUES ($1, $2, $3, $4, $5)`, [id, temperature, humidity, gas, fan]);
    for (const [type, active, message] of [
      ['high_temperature', temperature > Number(process.env.HIGH_TEMPERATURE_THRESHOLD || 30), 'Temperature exceeds safe limit'],
      ['high_humidity', humidity > Number(process.env.HIGH_HUMIDITY_THRESHOLD || 70), 'Humidity exceeds safe limit'],
      ['gas_presence', gas, 'Gas detected'],
    ]) {
      if (active) {
        await client.query(`INSERT INTO alerts (device_id, type, message)
          SELECT $1, $2, $3 WHERE NOT EXISTS (
            SELECT 1 FROM alerts WHERE device_id = $1 AND type = $2::varchar AND resolved_at IS NULL
          )`, [id, type, message]);
      } else {
        await client.query(`UPDATE alerts SET resolved_at = NOW()
          WHERE device_id = $1 AND type = $2 AND resolved_at IS NULL`, [id, type]);
      }
    }
    // Record an access event every 30 seconds without inventing a user.
    if (Math.floor(Date.now() / 5000) % 6 === 0 || once) {
      await client.query(`INSERT INTO access_logs (device_id, method, result, reason)
        VALUES ($1, 'rfid', $2, NULL)`, [id, gas ? 'denied' : 'granted']);
    }
    await client.query('COMMIT');
    console.log(`Sensor update: ${temperature} C, ${humidity}%, gas=${gas}, fan=${fan}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function tick() {
  timer = undefined;
  try { await writeSample(); }
  catch (error) {
    console.error(`Data update failed: ${error.message}${once ? '' : '; retrying in 5 seconds'}`);
    if (once) process.exitCode = 1;
  }
  if (once || stopping) await pool.end();
  else timer = setTimeout(tick, 5000);
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopping = true;
    if (timer) { clearTimeout(timer); pool.end(); }
  });
}
console.log('Sending sensor updates. Press Ctrl+C to stop.');
tick();
