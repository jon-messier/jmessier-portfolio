require('dotenv').config();
const express = require('express');
const { createClient } = require('@tursodatabase/serverless/compat');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const session = require('cookie-session');
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
    await db.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('logo_url', '')");
  }
}).catch(err => console.error("Database init error:", err));

// 2. Cloudflare R2 Setup
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// 3. Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
// Keep the login in a signed cookie, not server memory. On Vercel each request can hit a
// different server instance, so in-memory sessions get "forgotten" (→ "Unauthorized").
app.set('trust proxy', 1);
app.use(session({
  name: 'session',
  keys: [process.env.SESSION_SECRET],
  maxAge: 7 * 24 * 60 * 60 * 1000, // stay logged in for 7 days
  sameSite: 'lax',
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production'
}));

// Helper: Turso's rows are read-only, so assigning row.blocks = [...] silently does nothing.
// Copy each row into a plain object we're allowed to modify.
const toObjects = (result) =>
  result.rows.map(row => Object.fromEntries(result.columns.map((col, i) => [col, row[i]])));

const getSettings = async () => {
  const result = await db.execute("SELECT * FROM settings");
  const settings = {};
  toObjects(result).forEach(row => { settings[row.key] = row.value; });
  return settings;
};

// Helper: Guarantee an array is returned, even if the database double-stringified it
const safeParseBlocks = (blocksData) => {
  if (!blocksData) return [];
  try {
    const str = String(blocksData);
    let parsed = JSON.parse(str);
    
    // If the database returned a stringified string (e.g. '"[...]"'), parse it again
    if (typeof parsed === 'string') {
      parsed = JSON.parse(parsed);
    }
    
    return normalizeBlocks(parsed);
  } catch (err) {
    console.error("Failed to parse blocks:", err);
    return [];
  }
};

// Helper: Clean up a project's layout so only valid blocks get saved or shown.
//   { type: 'single', url }
//   { type: 'grid', rows, cols, gap, images: [url or null, ...] }  (null = empty slot)
//   { type: 'embed', code }
const isImageUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
const clampInt = (v, min, max, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const normalizeBlocks = (raw) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'single' && isImageUrl(b.url)) {
      out.push({ type: 'single', url: b.url });
    } else if (b.type === 'grid' && Array.isArray(b.images)) {
      const images = b.images.map(u => (isImageUrl(u) ? u : null));
      const cols = clampInt(b.cols, 1, 6, 2);
      // Never drop images: add rows if there are more images than slots
      const rows = Math.max(clampInt(b.rows, 1, 10, 1), Math.ceil(images.length / cols));
      while (images.length < rows * cols) images.push(null);
      const gap = Number.isFinite(Number(b.gap)) ? Math.min(4, Math.max(0, Number(b.gap))) : 1.5;
      out.push({ type: 'grid', rows, cols, gap, images });
    } else if (b.type === 'embed' && typeof b.code === 'string' && b.code.trim()) {
      out.push({ type: 'embed', code: b.code.trim() });
    }
  }
  return out;
};
const firstImage = (blocks) => {
  for (const b of blocks) {
    if (b.type === 'single') return b.url;
    if (b.type === 'grid') { const img = b.images.find(Boolean); if (img) return img; }
  }
  return '';
};

// 4. API Route for Direct-to-R2 Upload
app.post('/api/upload', async (req, res) => {
  if (!req.session.loggedIn) {
    console.log("Upload rejected: Not logged in");
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { filename, contentType } = req.body;
  const uniqueFilename = `img-${Date.now()}-${Math.round(Math.random() * 1000)}-${filename.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  
  try {
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: uniqueFilename,
      ContentType: contentType,
    });
    
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    
    res.json({ 
      uploadUrl: signedUrl, 
      finalUrl: `${process.env.R2_PUBLIC_URL}/${uniqueFilename}` 
    });
  } catch (err) {
    console.error("Failed to generate signed URL:", err);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// 5. Public Routes
app.get('/', async (req, res) => {
  try {
    const result = await db.execute("SELECT * FROM projects ORDER BY id DESC");
    const settings = await getSettings();
    res.render('index', { projects: toObjects(result), logoUrl: settings.logo_url });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading homepage.");
  }
});

app.get('/project/:id', async (req, res) => {
  try {
    const result = await db.execute({ sql: "SELECT * FROM projects WHERE id = ?", args: [req.params.id] });
    if (result.rows.length === 0) return res.status(404).send('Project not found');
    
    const project = toObjects(result)[0];
    project.blocks = safeParseBlocks(project.blocks);

    const allProjectsResult = await db.execute({ sql: "SELECT id, title, cover_image FROM projects WHERE id != ? ORDER BY id ASC", args: [req.params.id] });
    const otherProjects = toObjects(allProjectsResult);
    const settings = await getSettings();
    
    res.render('project', { project, logoUrl: settings.logo_url, otherProjects });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading project.");
  }
});

// 6. Admin Routes
app.get('/login', (req, res) => res.render('login'));

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await db.execute({ sql: "SELECT * FROM users WHERE username = ?", args: [username] });
    const user = toObjects(result)[0];
    if (user && bcrypt.compareSync(password, user.password)) {
      req.session.loggedIn = true;
      res.redirect('/admin');
    } else {
      res.send("Invalid credentials. <a href='/login'>Try again</a>");
    }
  } catch (err) {
    res.status(500).send("Login error");
  }
});

app.get('/admin', async (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');
  try {
    const result = await db.execute("SELECT * FROM projects ORDER BY id DESC");
    const settings = await getSettings();
    const cleanProjects = toObjects(result).map(p => {
      p.blocks = safeParseBlocks(p.blocks);
      return p;
    });
    res.render('admin', { projects: cleanProjects, logoUrl: settings.logo_url });
  } catch (err) {
    res.status(500).send("Error loading admin dashboard.");
  }
});

app.post('/admin/add', async (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');
  const { title, blocks } = req.body;
  try {
    // Safely parse the string sent from the browser into a real array
    const parsedBlocks = normalizeBlocks(blocks ? JSON.parse(blocks) : []);

    await db.execute({
      sql: "INSERT INTO projects (title, cover_image, blocks) VALUES (?, ?, ?)",
      args: [title, firstImage(parsedBlocks), JSON.stringify(parsedBlocks)]
    });
    res.redirect('/admin');
  } catch (err) { 
    console.error(err);
    res.status(500).send("Error adding project: " + err.message); 
  }
});

app.post('/admin/edit/:id', async (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');
  const { id } = req.params;
  const { title, description, blocks, cover_image } = req.body;
  
  try {
    let parsedBlocks = [];
    if (blocks) {
      const temp = JSON.parse(blocks);
      if (Array.isArray(temp)) parsedBlocks = temp;
    }

    let coverImageUrl = cover_image;
    if (!coverImageUrl && parsedBlocks.length > 0) {
      coverImageUrl = parsedBlocks[0].url;
    }

    await db.execute({
      sql: `UPDATE projects SET title = ?, description = ?, blocks = ?, cover_image = ? WHERE id = ?`,
      args: [title, description, JSON.stringify(parsedBlocks), coverImageUrl, id]
    });
    res.redirect('/admin');
  } catch (err) { 
    console.error(err);
    res.status(500).send("Error updating project: " + err.message); 
  }
});

// Save from the admin layout editor (JSON in, JSON out, so the page can show real errors)
app.post('/api/projects/:id', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: 'Your login expired. Open the login page in a new tab, log in, then click Save again. Your changes are still on this page.' });
  }
  const { title, description, blocks, cover_image } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'The project needs a title.' });

  const cleanBlocks = normalizeBlocks(blocks);
  const cover = isImageUrl(cover_image) ? cover_image : firstImage(cleanBlocks);

  try {
    const result = await db.execute({
      sql: `UPDATE projects SET title = ?, description = ?, blocks = ?, cover_image = ? WHERE id = ?`,
      args: [String(title).trim(), description || '', JSON.stringify(cleanBlocks), cover, req.params.id]
    });
    if (result.rowsAffected === 0) return res.status(404).json({ error: 'This project no longer exists.' });
    res.json({ ok: true, blocks: cleanBlocks, cover_image: cover });
  } catch (err) {
    console.error("Project save error:", err);
    res.status(500).json({ error: 'The database rejected the save: ' + err.message });
  }
});

app.post('/admin/delete/:id', async (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');
  try {
    await db.execute({ sql: "DELETE FROM projects WHERE id = ?", args: [req.params.id] });
    res.redirect('/admin');
  } catch (err) {
    res.status(500).send("Error deleting project.");
  }
});

app.post('/admin/settings/logo', async (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');
  const { logo_url } = req.body;
  if (logo_url) {
    try {
      // Insert the row if it's missing, otherwise update it
      await db.execute({ sql: "INSERT INTO settings (key, value) VALUES ('logo_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [logo_url] });
    } catch (err) {
      console.error("Logo update error:", err);
    }
  }
  res.redirect('/admin');
});

// 7. Vercel Export
if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, () => console.log('Server running at http://localhost:3000'));
}
module.exports = app;