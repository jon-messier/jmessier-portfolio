require('dotenv').config();
const { createClient } = require('@tursodatabase/serverless/compat');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function setup() {
  try {
    await db.batch([
      `CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, cover_image TEXT, description TEXT, blocks TEXT DEFAULT '[]')`,
      `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
      `CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER DEFAULT 0, first_at INTEGER DEFAULT 0, blocked_until INTEGER DEFAULT 0)`
    ]);
    console.log("Tables created successfully!");
  } catch (err) {
    console.error("Error creating tables:", err);
  }
}
setup();
