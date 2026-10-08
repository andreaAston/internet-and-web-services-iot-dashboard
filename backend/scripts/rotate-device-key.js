const crypto = require('node:crypto');
const pool = require('../db');

async function rotateDeviceKey() {
  const deviceUid = process.env.DEVICE_UID || 'main-entrance-pi';
  const deviceApiKey = process.env.DEVICE_API_KEY;
  if (!deviceApiKey || deviceApiKey.length < 32) {
    throw new Error('Set DEVICE_API_KEY to a random key of at least 32 characters');
  }

  const keyHash = crypto.createHash('sha256').update(deviceApiKey).digest('hex');
  const { rowCount } = await pool.query(
    'UPDATE devices SET api_key_hash = $1 WHERE device_uid = $2',
    [keyHash, deviceUid]
  );
  if (rowCount !== 1) throw new Error(`Device not found: ${deviceUid}`);
  console.log(`Device API key updated for ${deviceUid}. Update that device's .env to match.`);
}

rotateDeviceKey()
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());