// Run after importing the schema. Credentials are supplied only through environment variables.
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const pool = require('../db');

async function setup() {
  const { ADMIN_USERNAME, ADMIN_PASSWORD, DEVICE_API_KEY } = process.env;
  if (!ADMIN_USERNAME || ADMIN_USERNAME.length > 50 || !ADMIN_PASSWORD ||
      Buffer.byteLength(ADMIN_PASSWORD) > 72 || !DEVICE_API_KEY) {
    throw new Error('Set ADMIN_USERNAME (max 50 characters), ADMIN_PASSWORD (max 72 bytes), and DEVICE_API_KEY');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO admins (username, password_hash) VALUES ($1, $2)
      ON CONFLICT (username) DO NOTHING`, [ADMIN_USERNAME, await bcrypt.hash(ADMIN_PASSWORD, 12)]);
    await client.query(`INSERT INTO devices (device_uid, name, api_key_hash) VALUES ($1, $2, $3)
      ON CONFLICT (device_uid) DO NOTHING`, [process.env.DEVICE_UID || 'main-entrance-pi', process.env.DEVICE_NAME || process.env.DEVICE_UID || 'Main entrance Raspberry Pi',
      crypto.createHash('sha256').update(DEVICE_API_KEY).digest('hex')]);
    await client.query('COMMIT');
    console.log('Admin and device created if missing. Existing credentials were not changed.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
setup().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
