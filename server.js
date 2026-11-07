require('dotenv').config();
const express = require('express');
const { createClient } = require('@tursodatabase/serverless/compat');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
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

const safeParseBlocks = (blocksData) => {
  if (!blocksData) return [];
  try {
    const str = String(blocksData);
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
};

// 4. API Route for Direct-to-R2 Upload
app.post('/api/upload', async (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Unauthorized' });
  
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
    res.render('index', { projects: result.rows, logoUrl: settings.logo_url });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading homepage.");
  }
});

app.get('/project/:id', async (req, res) => {
  try {
    const result = await db.execute({ sql: "SELECT * FROM projects WHERE id = ?", args: [req.params.id] });
    if (result.rows.length === 0) return res.status(404).send('Project not found');
    
    const project = result.rows[0];
    project.blocks = safeParseBlocks(project.blocks);
    
    const allProjectsResult = await db.execute("SELECT id, title, cover_image FROM projects WHERE id != ? ORDER BY id ASC", [req.params.id]);
    const otherProjects = allProjectsResult.rows;
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
    const user = result.rows[0];
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
    const cleanProjects = result.rows.map(p => {
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
    const parsedBlocks = typeof blocks === 'string' ? JSON.parse(blocks) : blocks;
    await db.execute({
      sql: "INSERT INTO projects (title, cover_image, blocks) VALUES (?, ?, ?)",
      args: [title, parsedBlocks.length > 0 ? parsedBlocks[0].url : '', JSON.stringify(parsedBlocks)]
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
    const parsedBlocks = typeof blocks === 'string' ? JSON.parse(blocks) : blocks;
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
      await db.execute({ sql: "UPDATE settings SET value = ? WHERE key = 'logo_url'", args: [logo_url] });
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