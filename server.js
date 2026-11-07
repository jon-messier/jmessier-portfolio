require('dotenv').config();
const express = require('express');
const { createClient } = require('@tursodatabase/serverless/compat');
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

// Helper: Guarantee an array is returned
const safeParseBlocks = (blocksData) => {
  if (!blocksData) return [];
  try {
    // Force to string in case Turso returns a buffer or object
    const str = String(blocksData);
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Failed to parse blocks:", err);
    return [];
  }
};

// 4. Public Routes
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
    
    // Force it to be an array here
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

// 5. Admin Routes
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
    
    // Clean up the blocks before sending to admin view
    const cleanProjects = result.rows.map(p => {
      p.blocks = safeParseBlocks(p.blocks);
      return p;
    });

    res.render('admin', { projects: cleanProjects, logoUrl: settings.logo_url });
  } catch (err) {
    res.status(500).send("Error loading admin dashboard.");
  }
});

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
  } catch (err) { 
    console.error(err);
    res.status(500).send("Error adding project: " + err.message); 
  }
});

app.post('/admin/edit/:id', upload.fields([{ name: 'cover_image', maxCount: 1 }, { name: 'new_images', maxCount: 20 }]), async (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');
  const { id } = req.params;
  const { title, description, blocks_json_base64 } = req.body;
  
  try {
    let blocks = [];
    
    if (blocks_json_base64) {
      try {
        const decodedString = Buffer.from(blocks_json_base64, 'base64').toString('utf8');
        blocks = safeParseBlocks(decodedString);
      } catch (e) {
        console.error("Failed to decode blocks base64:", e);
      }
    }

    let coverImageUrl = '';

    if (req.files['cover_image'] && req.files['cover_image'][0]) {
      coverImageUrl = await processAndUpload(req.files['cover_image'][0].buffer);
    } else {
      const existing = await db.execute({ sql: "SELECT cover_image FROM projects WHERE id = ?", args: [id] });
      coverImageUrl = existing.rows[0].cover_image;
    }

    if (req.files['new_images'] && req.files['new_images'].length > 0) {
      for (const file of req.files['new_images']) {
        try {
          const url = await processAndUpload(file.buffer);
          blocks.push({ type: 'single', url: url });
        } catch (uploadError) {
          console.error("Failed to upload image:", uploadError);
        }
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

app.post('/admin/settings/logo', upload.single('logo'), async (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');
  if (req.file) {
    try {
      const logoUrl = await processAndUpload(req.file.buffer);
      await db.execute({ sql: "UPDATE settings SET value = ? WHERE key = 'logo_url'", args: [logoUrl] });
    } catch (err) {
      console.error("Logo upload error:", err);
    }
  }
  res.redirect('/admin');
});

// 6. Vercel Export
if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, () => console.log('Server running at http://localhost:3000'));
}
module.exports = app;