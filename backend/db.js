const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { Pool } = require('pg');

const databaseConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '',
    };

const pool = new Pool({
  ...databaseConfig,
  ...(process.env.DB_SSL === 'true' ? { ssl: true } : {}),
  connectionTimeoutMillis: 5000,
});

pool.on('error', (error) => console.error('Idle database connection error:', error.message));
module.exports = pool;
