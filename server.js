require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client/web');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();

// 1. Database Setup
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

db.batch([
  `CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, cover_image TEXT, description TEXT, blocks TEXT DEFAULT '[]')`,
  `CREATE TABLE IF NOT EXISTS users (username TEXT, password TEXT)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`
]).then(async () => {
  const admin = await db.execute("SELECT * FROM users WHERE username = 'admin'");
  if (admin.rows.length === 0) {
    const hashedPassword = bcrypt.hashSync('password123', 10);
    await db.execute({ sql: "INSERT INTO users (username, password) VALUES (?, ?)", args: ['admin', hashedPassword] });
  }
  const logoSetting = await db.execute("SELECT * FROM settings WHERE key = 'logo_url'");
  if (logoSetting.rows.length === 0) {
    await db.execute("INSERT INTO settings (key, value) VALUES ('logo_url', '')");
  }
});

// 2. Cloudflare R2 Setup
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const upload = multer({ storage: multer.memoryStorage() });

// Image Processing & Upload (PNG -> WebP -> R2)
const processAndUpload = async (fileBuffer) => {
  const webpBuffer = await sharp(fileBuffer).webp({ quality: 80 }).toBuffer();
  const fileName = `img-${Date.now()}-${Math.round(Math.random() * 1000)}.webp`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: fileName,
    Body: webpBuffer,
    ContentType: 'image/webp',
  }));
  return `${process.env.R2_PUBLIC_URL}/${fileName}`;
};

// 3. Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));

const getSettings = async () => {
  const result = await db.execute("SELECT * FROM settings");
  const settings = {};
  result.rows.forEach(row => { settings[row.key] = row.value; });
  return settings;
};

// 4. Routes
app.get('/', async (req, res) => {
  const result = await db.execute("SELECT * FROM projects ORDER BY id DESC");
  const settings = await getSettings();
  res.render('index', { projects: result.rows, logoUrl: settings.logo_url });
});

app.get('/project/:id', async (req, res) => {
  const result = await db.execute({ sql: "SELECT * FROM projects WHERE id = ?", args: [req.params.id] });
  if (result.rows.length === 0) return res.status(404).send('Project not found');
  const project = result.rows[0];
  project.blocks = JSON.parse(project.blocks || '[]');
  
  const allProjectsResult = await db.execute("SELECT id, title, cover_image FROM projects WHERE id != ? ORDER BY id ASC", [req.params.id]);
  const otherProjects = allProjectsResult.rows;
  const settings = await getSettings();
  
  res.render('project', { project, logoUrl: settings.logo_url, otherProjects });
});

// Admin Login
app.get('/login', (req, res) => res.render('login'));
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await db.execute({ sql: "SELECT * FROM users WHERE username = ?", args: [username] });
  const user = result.rows[0];
  if (user && bcrypt.compareSync(password, user.password)) {
    req.session.loggedIn = true;
    res.redirect('/admin');
  } else {
    res.send("Invalid credentials. <a href='/login'>Try again</a>");
  }
});

// Admin Dashboard
app.get('/admin', async (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');
  const result = await db.execute("SELECT * FROM projects ORDER BY id DESC");
  const settings = await getSettings();
  res.render('admin', { projects: result.rows, logoUrl: settings.logo_url });
});

// Add Project
app.post('/admin/add', upload.array('images', 20), async (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');
  const { title } = req.body;
  try {
    const blocks = [];
    if (req.files && req.files.length > 0) {
      const uploadPromises = req.files.map(file => processAndUpload(file.buffer));
      const urls = await Promise.all(uploadPromises);
      urls.forEach(url => blocks.push({ type: 'single', url: url }));
    }
    await db.execute({
      sql: "INSERT INTO projects (title, cover_image, blocks) VALUES (?, ?, ?)",
      args: [title, blocks.length > 0 ? blocks[0].url : '', JSON.stringify(blocks)]
    });
    res.redirect('/admin');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// Edit Project
app.post('/admin/edit/:id', upload.fields([{ name: 'cover_image', maxCount: 1 }, { name: 'new_images', maxCount: 20 }]), async (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');
  const { id } = req.params;
  const { title, description, blocks_json } = req.body;
  try {
    let blocks = JSON.parse(blocks_json || '[]');
    let coverImageUrl = '';

    if (req.files['cover_image'] && req.files['cover_image'][0]) {
      coverImageUrl = await processAndUpload(req.files['cover_image'][0].buffer);
    } else {
      const existing = await db.execute({ sql: "SELECT cover_image FROM projects WHERE id = ?", args: [id] });
      coverImageUrl = existing.rows[0].cover_image;
    }

    if (req.files['new_images'] && req.files['new_images'].length > 0) {
      for (const file of req.files['new_images']) {
        const url = await processAndUpload(file.buffer);
        blocks.push({ type: 'single', url: url });
      }
    }

    const newEmbedCode = req.body.new_embed_code;
    if (newEmbedCode && newEmbedCode.trim() !== '') {
      blocks.push({ type: 'embed', code: newEmbedCode.trim() });
    }

    await db.execute({
      sql: `UPDATE projects SET title = ?, description = ?, blocks = ?, cover_image = ? WHERE id = ?`,
      args: [title, description, JSON.stringify(blocks), coverImageUrl, id]
    });
    res.redirect('/admin');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// Delete Project
app.post('/admin/delete/:id', async (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');
  await db.execute({ sql: "DELETE FROM projects WHERE id = ?", args: [req.params.id] });
  res.redirect('/admin');
});

// Upload Logo
app.post('/admin/settings/logo', upload.single('logo'), async (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');
  if (req.file) {
    const logoUrl = await processAndUpload(req.file.buffer);
    await db.execute({ sql: "UPDATE settings SET value = ? WHERE key = 'logo_url'", args: [logoUrl] });
  }
  res.redirect('/admin');
});

// Vercel Export
if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, () => console.log('Server running at http://localhost:3000'));
}
module.exports = app;