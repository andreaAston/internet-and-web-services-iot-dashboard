const express = require('express');
const pool = require('./db');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { cookieToken, requirePageLogin, requireLogin } = require('./middleware');
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use('/api', require('./deviceAccess'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'frontend', 'views'));
app.use(express.static(path.join(__dirname, '..', 'frontend', 'public')));
app.use('/vendor/jquery', express.static(path.join(__dirname, 'node_modules/jquery/dist')));
app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules/chart.js/dist')));
app.use('/uploads', requireLogin, express.static(path.join(__dirname, 'uploads'), { dotfiles: 'deny', index: false }));

app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => {
  try {
    jwt.verify(cookieToken(req), process.env.JWT_SECRET, { algorithms: ['HS256'] });
    return res.redirect('/rooms');
  } catch { return res.render('login'); }
});
app.get('/rooms', requirePageLogin, (req, res) => res.render('rooms', { admin: req.admin }));
app.get('/dashboard', requirePageLogin, async (req, res) => {
  if (typeof req.query.device_uid !== 'string') return res.redirect('/rooms');
  const { rows } = await pool.query('SELECT name FROM devices WHERE device_uid = $1', [req.query.device_uid]);
  if (!rows.length) return res.redirect('/rooms');
  res.render('dashboard', { admin: req.admin, room: rows[0].name });
});
app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'smart_access_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.redirect('/login');
});

app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/devices'));
app.use('/api', require('./routes/telemetry'));
app.use('/api', require('./routes/access'));
app.use('/api', require('./routes/snapshots'));
app.use('/api', require('./routes/dashboard'));
app.use((req, res) => res.status(404).json({ success: false, message: 'Endpoint not found' }));
app.use((error, req, res, next) => {
  if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, message: 'Image must be at most 5 MB' });
  if (error.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'Invalid JSON' });
  if (error.type === 'entity.too.large') return res.status(413).json({ success: false, message: 'Request too large' });
  if (error.name === 'MulterError' || error.status === 400) return res.status(400).json({ success: false, message: 'Invalid image upload' });
  if (error.code === '23503') return res.status(400).json({ success: false, message: 'Referenced user, card or snapshot does not exist' });
  console.error('Request failed:', error.message);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

async function start() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'my_secret_key') throw new Error('Set a private JWT_SECRET in .env');
  await pool.query('SELECT 1');
  console.log('PostgreSQL connected');

  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port);

  server.on('listening', () => {
    console.log(`Server running on port ${server.address().port}`);
  });

  server.on('error', async error => {
    console.error(error.message);
    await pool.end();
    process.exitCode = 1;
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close(async () => { await pool.end(); }));
  }
}
if (require.main === module) start().catch(async error => {
  console.error('Startup failed:', error.message);
  await pool.end();
  process.exitCode = 1;
});
module.exports = app;

