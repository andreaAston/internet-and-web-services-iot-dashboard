const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const bcrypt = require('bcrypt');
const app = require('../server');
const pool = require('../db');

test('final schema HTTP integration', async t => {
  const uid = `test-${crypto.randomUUID()}`;
  const key = crypto.randomBytes(24).toString('hex');
  const password = crypto.randomBytes(16).toString('hex');
  let server;
  let userId;
  let snapshotPath;
  let deviceId;
  let cardUid;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (deviceId) await pool.query('DELETE FROM devices WHERE id = $1', [deviceId]);
    if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query('DELETE FROM admins WHERE username = $1', [uid]);
    if (snapshotPath) await fs.unlink(require('node:path').join(__dirname, '..', 'uploads', snapshotPath.slice('/uploads/'.length))).catch(() => {});
    await pool.end();
  });

  await pool.query('SELECT 1');
  deviceId = (await pool.query(`INSERT INTO devices (device_uid, name, api_key_hash)
    VALUES ($1, 'Integration test', $2) RETURNING id`,
  [uid, crypto.createHash('sha256').update(key).digest('hex')])).rows[0].id;
  userId = (await pool.query('INSERT INTO users (name, pin_hash) VALUES ($1, $2) RETURNING id',
    [`Test ${uid}`, await bcrypt.hash('1234', 10)])).rows[0].id;
  cardUid = `card-${crypto.randomUUID()}`;
  await pool.query('INSERT INTO cards (user_id, uid_hash) VALUES ($1, $2)',
    [userId, crypto.createHash('sha256').update(cardUid).digest('hex')]);
  await pool.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', [uid, await bcrypt.hash(password, 10)]);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  let base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(route, body, headers = {}) {
    const response = await fetch(base + route, {
      method: body ? 'POST' : 'GET', headers: body instanceof FormData ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
    });
    const contentType = response.headers.get('content-type') || '';
    return { status: response.status, headers: response.headers,
      body: contentType.includes('json') ? await response.json() : await response.arrayBuffer() };
  }
  assert.equal((await request('/dashboard?device_uid=' + uid)).status, 401);
  assert.equal((await request('/login', { username: uid, password: 'wrong' })).status, 401);
  const login = await request('/login', { username: uid, password });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
  assert.equal(login.body.password_hash, undefined);
  const auth = { Authorization: `Bearer ${login.body.token}` };
  assert.match(login.headers.get('set-cookie') || '', /HttpOnly/);
  assert.equal((await fetch(`${base.slice(0, -4)}/rooms`, { redirect: 'manual' })).status, 302);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const actualPage = await fetch(`${base.slice(0, -4)}/dashboard?device_uid=${uid}`, { headers: { Cookie: cookie } });
  assert.equal(actualPage.status, 200);
  assert.match(await actualPage.text(), /Temperature &amp; Humidity History/);
  assert.equal((await fetch(`${base.slice(0, -4)}/dashboard?device_uid=missing`, { headers: { Cookie: cookie }, redirect: 'manual' })).status, 302);
  for (const asset of ['/css/login.css', '/css/rooms.css', '/css/dashboard.css', '/js/dashboard.js',
    '/images/actual-room.png', '/images/simulated-room.png', '/vendor/jquery/jquery.min.js', '/vendor/chart.js/chart.umd.js']) {
    assert.equal((await fetch(`${base.slice(0, -4)}${asset}`)).status, 200, `${asset} should be served`);
  }
  const deviceList = await request('/devices', null, auth);
  assert.equal(deviceList.status, 200);
  assert.ok(deviceList.body.some(device => device.device_uid === uid));
  const pi = { 'X-API-Key': key };
  const accessPair = { device_uid: uid, card_uid: cardUid, pin: '1234' };
  assert.equal((await request('/device/verify-access', accessPair)).status, 401);
  const invalidPair = await request('/device/verify-access', { ...accessPair, pin: '4321' }, pi);
  assert.equal(invalidPair.status, 200);
  assert.deepEqual(invalidPair.body, { granted: false, reason: 'invalid_credentials' });
  const verifiedPair = await request('/device/verify-access', accessPair, pi);
  assert.equal(verifiedPair.status, 200);
  assert.equal(verifiedPair.body.granted, true);
  assert.equal(verifiedPair.body.reason, 'authorized');
  assert.equal(verifiedPair.body.user_id, userId);
  assert.ok(Number.isInteger(verifiedPair.body.card_id));
  assert.equal(verifiedPair.body.name, `Test ${uid}`);
  const badJson = await fetch(base + '/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json', ...pi }, body: '{invalid' });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).message, 'Invalid JSON');
  assert.equal((await request('/telemetry', { device_uid: uid }, pi)).status, 400);
  assert.equal((await request('/access', { device_uid: uid, method: 'pin', result: 'denied', user_id: 2147483647 }, pi)).status, 400);
  const payload = { device_uid: uid, temperature: 24.6, humidity: 58, gas_present: false, fan_on: false };
  assert.equal((await request('/telemetry', payload)).status, 401);
  assert.equal((await request('/telemetry', { ...payload, humidity: 101 }, pi)).status, 400);
  assert.equal((await request('/telemetry', { ...payload, gas_present: 0 }, pi)).status, 400);
  await pool.query(`INSERT INTO readings (device_id, temperature, humidity, gas_present, fan_on, recorded_at)
    VALUES ($1, 21, 40, FALSE, FALSE, NOW() - INTERVAL '2 hours')`, [deviceId]);
  assert.equal((await request('/telemetry', payload, pi)).status, 200);
  const oneHour = await request(`/readings/summary?hours=1&device_uid=${uid}`, null, auth);
  const sixHours = await request(`/readings/summary?hours=6&device_uid=${uid}`, null, auth);
  assert.equal(oneHour.status, 200);
  assert.equal(sixHours.status, 200);
  assert.ok(oneHour.body.every(bucket => bucket.temperature !== 21));
  assert.ok(sixHours.body.some(bucket => bucket.temperature === 21));
  assert.equal((await request(`/readings/summary?hours=3&device_uid=${uid}`, null, auth)).status, 400);

  for (const [method, result, reason, user_id] of [
    ['rfid', 'granted', null, userId], ['pin', 'denied', 'wrong_pin', null],
  ]) {
    assert.equal((await request('/access', { device_uid: uid, method, result, reason, user_id }, pi)).status, 201);
  }
  assert.equal((await request('/access', { device_uid: uid, method: 'invalid', result: 'granted' }, pi)).status, 400);
  const logs = await request(`/access-logs?limit=20&device_uid=${uid}`, null, auth);
  assert.equal(logs.status, 200);
  assert.ok(logs.body.some(row => row.device_uid === uid && row.user_name === `Test ${uid}`));
  assert.ok(logs.body.some(row => row.device_uid === uid && row.user_name === null && row.reason === 'wrong_pin'));

  const current = await request(`/dashboard/current?device_uid=${uid}`, null, auth);
  assert.equal(current.status, 200);
  assert.equal(current.body.temperature, 24.6);
  assert.equal(current.body.humidity, 58);
  assert.equal(current.body.gas_status, 'safe');
  assert.equal(current.body.fan_status, 'off');
  assert.equal(current.body.device_online, true);
  assert.ok(current.body.last_seen);
  assert.deepEqual(Object.keys(current.body).sort(),
    ['device_online', 'fan_status', 'gas_status', 'humidity', 'last_seen', 'temperature'].sort());

  const form = new FormData();
  form.set('device_uid', uid);
  form.set('reason', 'denied_access');
  form.set('image', new Blob([Buffer.from('small test image')], { type: 'image/png' }), 'camera.png');
  const snapshot = await request('/snapshots', form, pi);
  assert.equal(snapshot.status, 201);
  snapshotPath = snapshot.body.file_path;
  const latest = await request(`/snapshots/latest?device_uid=${uid}`, null, auth);
  assert.equal(latest.status, 200);
  assert.equal(latest.body.file_path, snapshotPath);
  assert.equal(latest.body.reason, 'denied_access');
  assert.equal(latest.body.device_name, 'Integration test');
  assert.ok(latest.body.captured_at);
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}${snapshotPath}`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}${snapshotPath}`, { headers: auth })).status, 200);

  const alerts = await Promise.all(Array.from({ length: 3 }, () => request('/telemetry',
    { ...payload, temperature: 32.1, humidity: 72, gas_present: true }, pi)));
  assert.ok(alerts.every(result => result.status === 200));
  const active = await pool.query('SELECT type FROM alerts WHERE device_id = $1 AND resolved_at IS NULL ORDER BY type', [deviceId]);
  assert.deepEqual(active.rows.map(row => row.type), ['gas_presence', 'high_humidity', 'high_temperature']);
  const alertRows = await request(`/alerts?limit=20&device_uid=${uid}`, null, auth);
  assert.ok(alertRows.body.filter(row => row.device_uid === uid).every(row => row.status === 'Active'));
  const unavailable = { ...payload, temperature: null, humidity: null, gas_present: null, fan_on: null };
  assert.equal((await request('/telemetry', unavailable, pi)).status, 200);
  const missing = await request(`/dashboard/current?device_uid=${uid}`, null, auth);
  assert.equal(missing.body.temperature, null);
  assert.equal(missing.body.gas_status, null);
  assert.equal(missing.body.device_online, true);
  const retained = await pool.query('SELECT COUNT(*)::int AS count FROM alerts WHERE device_id = $1 AND resolved_at IS NULL', [deviceId]);
  assert.equal(retained.rows[0].count, 3, 'Missing sensor readings must not clear alerts');
  assert.equal((await request('/telemetry', { ...payload, temperature: 'broken' }, pi)).status, 400);
  assert.equal((await request('/telemetry', { ...payload, temperature: null }, pi)).status, 200);
  assert.equal((await request(`/dashboard/current?device_uid=${uid}`, null, auth)).body.humidity, 58);
  const history = await request(`/readings?limit=2&device_uid=${uid}`, null, auth);
  assert.equal(history.status, 200);
  assert.equal(history.body.length, 2);
  assert.ok(new Date(history.body[0].recorded_at) <= new Date(history.body[1].recorded_at));
  assert.equal('gas_present' in history.body[0], false);
  assert.equal((await request('/readings?limit=0', null, auth)).status, 400);

  await request('/telemetry', payload, pi);
  const cleared = await pool.query('SELECT COUNT(*)::int AS count FROM alerts WHERE device_id = $1 AND resolved_at IS NULL', [deviceId]);
  assert.equal(cleared.rows[0].count, 0);
  await pool.query("UPDATE devices SET last_seen = NOW() - INTERVAL '3 minutes' WHERE id = $1", [deviceId]);
  assert.equal((await request(`/dashboard?device_uid=${uid}`, null, auth)).body.device_online, false);
  assert.equal((await request('/telemetry', payload, pi)).status, 200);
  assert.equal((await request(`/dashboard?device_uid=${uid}`, null, auth)).body.device_online, true);

  // Reopen the HTTP listener: persisted readings and the existing JWT remain usable.
  await new Promise(resolve => server.close(resolve));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  const recovered = await request(`/dashboard?device_uid=${uid}`, null, auth);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.temperature, payload.temperature);
});
