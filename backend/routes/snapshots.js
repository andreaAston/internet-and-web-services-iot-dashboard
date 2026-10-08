const router = require('express').Router();
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const multer = require('multer');
const pool = require('../db');
const { requireDevice, requireLogin } = require('../middleware');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, done) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return done(Object.assign(new Error('Only JPEG, PNG and WebP snapshots are allowed'), { status: 400 }));
    }
    done(null, true);
  },
});

router.post('/snapshots', upload.single('image'), requireDevice, async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'Upload an image in the image field' });
  if (req.body.reason !== undefined && (typeof req.body.reason !== 'string' || req.body.reason.length > 50)) {
    return res.status(400).json({ success: false, message: 'reason must be at most 50 characters' });
  }
  const reason = typeof req.body.reason === 'string' && req.body.reason.trim()
    ? req.body.reason.trim().slice(0, 50) : null;
  const extension = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' })[req.file.mimetype];
  const filename = `${Date.now()}-${crypto.randomUUID()}${extension}`;
  const diskPath = path.join(__dirname, '..', 'uploads', filename);
  const filePath = `/uploads/${filename}`;
  try {
    await fs.writeFile(diskPath, req.file.buffer, { flag: 'wx' });
    await pool.query('INSERT INTO snapshots (device_id, file_path, reason) VALUES ($1, $2, $3)',
      [req.deviceId, filePath, reason]);
  } catch (error) {
    await fs.unlink(diskPath).catch(() => {});
    throw error;
  }
  res.status(201).json({ success: true, file_path: filePath });
});

router.get('/snapshots/latest', requireLogin, async (req, res) => {
  const values = [];
  const filter = typeof req.query.device_uid === 'string' && req.query.device_uid.trim()
    ? (values.push(req.query.device_uid.trim()), 'WHERE d.device_uid = $1') : '';
  const { rows } = await pool.query(`SELECT s.file_path, s.reason, s.captured_at, d.name AS device_name
    FROM snapshots s JOIN devices d ON d.id = s.device_id ${filter}
    ORDER BY s.captured_at DESC, s.id DESC LIMIT 1`, values);
  if (!rows.length) return res.status(404).json({ success: false, message: 'No snapshots found' });
  res.json(rows[0]);
});

module.exports = router;
