const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !username.trim() || username.length > 50 ||
      typeof password !== 'string' || !password || Buffer.byteLength(password) > 72) {
    return res.status(400).json({ success: false, message: 'Valid username and password required' });
  }
  const { rows } = await pool.query('SELECT id, username, password_hash FROM admins WHERE username = $1', [username]);
  const admin = rows[0];
  if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
    return res.status(401).json({ success: false, message: 'Invalid username or password' });
  }
  const token = jwt.sign({ sub: String(admin.id), username: admin.username }, process.env.JWT_SECRET, { expiresIn: '8h', algorithm: 'HS256' });
  res.setHeader('Set-Cookie', `smart_access_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  res.json({ success: true, token });
});

module.exports = router;
