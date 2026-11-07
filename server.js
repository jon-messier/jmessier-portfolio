require('dotenv').config();
const express = require('express');
const { createClient } = require('@tursodatabase/serverless/compat');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const session = require('cookie-session');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();

// Options the admin can pick from (anything else sent to the server is ignored)
const DEFAULT_BG = '#181818';             // site background: a little lighter than the old #111
const PAGE_WIDTHS = [640, 860, 1100, 1400]; // project page width, in pixels
const BLOCK_GAPS = [0, 1, 2, 4];            // space between images on a project page, in rem
const DEFAULT_WIDTH = 1100;
const DEFAULT_BLOCK_GAP = 2;

// ---------------------------------------------------------------------------
// 1. Database
// ---------------------------------------------------------------------------
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Turso's rows are read-only, so assigning row.blocks = [...] silently does nothing.
// Copy each row into a plain object we're allowed to modify.
const toObjects = (result) =>
  result.rows.map(row => Object.fromEntries(result.columns.map((col, i) => [col, row[i]])));

// Run a setup statement, ignoring "already done" errors (two servers may start at once)
const tryExec = async (stmt) => {
  try { await db.execute(stmt); }
  catch (err) { if (!/duplicate column|already exists/i.test(err.message)) console.error('Database setup step failed:', err.message); }
};

// Turn a title into a URL name: "Minnesota Blizzard!" -> "minnesota-blizzard"
const slugify = (title) => String(title || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  .slice(0, 60).replace(/-+$/, '') || 'project';

// A URL name no other project uses. Duplicates get -2, -3, ...
async function uniqueSlug(title, excludeId) {
  const base = slugify(title);
  const rows = toObjects(await db.execute({
    sql: "SELECT slug FROM projects WHERE (slug = ? OR slug LIKE ?) AND id != ?",
    args: [base, base + '-%', excludeId ?? -1]
  }));
  const taken = new Set(rows.map(r => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

// Creates tables and upgrades older databases in place. Existing projects keep all their data.
async function initDatabase() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, cover_image TEXT, description TEXT, blocks TEXT DEFAULT '[]')`,
    `CREATE TABLE IF NOT EXISTS users (username TEXT, password TEXT)`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
    `CREATE TABLE IF NOT EXISTS slug_redirects (old_slug TEXT PRIMARY KEY, project_id INTEGER)`,
    `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, message TEXT, created_at TEXT, is_read INTEGER DEFAULT 0)`
  ]);

  const cols = toObjects(await db.execute('PRAGMA table_info(projects)')).map(c => c.name);
  const addColumn = async (name, definition) => {
    if (cols.includes(name)) return false;
    await tryExec(`ALTER TABLE projects ADD COLUMN ${name} ${definition}`);
    return true;
  };
  await addColumn('slug', 'TEXT');
  await addColumn('hidden', 'INTEGER DEFAULT 0');
  await addColumn('bg_color', "TEXT DEFAULT ''");
  await addColumn('block_gap', `REAL DEFAULT ${DEFAULT_BLOCK_GAP}`);
  await addColumn('content_width', `INTEGER DEFAULT ${DEFAULT_WIDTH}`);
  if (await addColumn('sort_order', 'INTEGER DEFAULT 0')) {
    await tryExec('UPDATE projects SET sort_order = -id'); // keep today's order (newest first)
  }

  // Give every existing project a URL name
  const missing = toObjects(await db.execute("SELECT id, title FROM projects WHERE slug IS NULL OR slug = ''"));
  for (const p of missing) {
    await db.execute({ sql: 'UPDATE projects SET slug = ? WHERE id = ?', args: [await uniqueSlug(p.title, p.id), p.id] });
  }
  await tryExec('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug)');

  const admin = await db.execute("SELECT * FROM users WHERE username = 'admin'");
  if (admin.rows.length === 0) {
    const hashedPassword = bcrypt.hashSync('password123', 10);
    await db.execute({ sql: "INSERT INTO users (username, password) VALUES (?, ?)", args: ['admin', hashedPassword] });
  }
  await db.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('logo_url', '')");
  await db.execute({ sql: "INSERT OR IGNORE INTO settings (key, value) VALUES ('bg_color', ?)", args: [DEFAULT_BG] });
}
const ready = initDatabase().catch(err => console.error("Database init error:", err));

// ---------------------------------------------------------------------------
// 2. Cloudflare R2 Setup
// ---------------------------------------------------------------------------
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// ---------------------------------------------------------------------------
// 3. Middleware
// ---------------------------------------------------------------------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
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
// Wait for the database setup to finish before handling any page
app.use(async (req, res, next) => { await ready; next(); });

const requireLoginPage = (req, res, next) => (req.session.loggedIn ? next() : res.redirect('/login'));
const requireLoginApi = (req, res, next) => (req.session.loggedIn ? next() : res.status(401).json({
  error: 'Your login expired. Open the login page in a new tab, log in, then try again. Your changes are still on this page.'
}));

// ---------------------------------------------------------------------------
// 4. Helpers
// ---------------------------------------------------------------------------
const isColor = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
const pickNumber = (value, allowed, fallback) => (allowed.includes(Number(value)) ? Number(value) : fallback);

const getSettings = async () => {
  const result = await db.execute("SELECT * FROM settings");
  const settings = {};
  toObjects(result).forEach(row => { settings[row.key] = row.value; });
  return settings;
};

// Values every public page needs (logo + site background color)
const siteInfo = async () => {
  const s = await getSettings();
  return { logoUrl: s.logo_url || '', siteBg: isColor(s.bg_color) ? s.bg_color : DEFAULT_BG };
};

// Guarantee an array is returned, even if the database double-stringified it
const safeParseBlocks = (blocksData) => {
  if (!blocksData) return [];
  try {
    let parsed = JSON.parse(String(blocksData));
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    return normalizeBlocks(parsed);
  } catch (err) {
    console.error("Failed to parse blocks:", err);
    return [];
  }
};

// Clean up a project's layout so only valid blocks get saved or shown.
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

// A project row ready for templates (settings filled in with safe defaults)
const prepareProject = (p) => Object.assign(p, {
  blocks: safeParseBlocks(p.blocks),
  hidden: Number(p.hidden) === 1,
  bg_color: isColor(p.bg_color) ? p.bg_color : '',
  block_gap: pickNumber(p.block_gap, BLOCK_GAPS, DEFAULT_BLOCK_GAP),
  content_width: pickNumber(p.content_width, PAGE_WIDTHS, DEFAULT_WIDTH)
});

const ORDER = 'ORDER BY sort_order ASC, id DESC';

// ---------------------------------------------------------------------------
// 5. Theme colors: /theme.css?bg=#rrggbb
// Text, borders and the logo switch between light and dark so they stay readable.
// ---------------------------------------------------------------------------
function themeCss(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const dark = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.55;
  const ink = dark ? '255, 255, 255' : '0, 0, 0';
  return `:root {
  --bg: ${hex};
  --header-bg: rgba(${r}, ${g}, ${b}, 0.95);
  --text: ${dark ? '#ffffff' : '#111111'};
  --muted: rgba(${ink}, 0.55);
  --border: rgba(${ink}, 0.12);
  --raised: rgba(${ink}, 0.07);
  --logo-filter: ${dark ? 'brightness(0) invert(1)' : 'brightness(0)'};
}
`;
}
app.get('/theme.css', (req, res) => {
  const bg = isColor(req.query.bg) ? req.query.bg : DEFAULT_BG;
  res.type('text/css').set('Cache-Control', 'public, max-age=31536000, immutable').send(themeCss(bg));
});

// ---------------------------------------------------------------------------
// 6. Uploads straight to Cloudflare R2 (images never pass through Vercel)
// ---------------------------------------------------------------------------
app.post('/api/upload', requireLoginApi, async (req, res) => {
  const { filename = 'image', contentType } = req.body || {};
  const uniqueFilename = `img-${Date.now()}-${Math.round(Math.random() * 1000)}-${String(filename).replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  try {
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: uniqueFilename,
      ContentType: contentType,
    });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    res.json({ uploadUrl: signedUrl, finalUrl: `${process.env.R2_PUBLIC_URL}/${uniqueFilename}` });
  } catch (err) {
    console.error("Failed to generate signed URL:", err);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// ---------------------------------------------------------------------------
// 7. Public pages
// ---------------------------------------------------------------------------
app.get('/', async (req, res) => {
  try {
    const result = await db.execute(`SELECT id, title, slug, cover_image FROM projects WHERE hidden = 0 ${ORDER}`);
    const site = await siteInfo();
    res.render('index', { projects: toObjects(result), logoUrl: site.logoUrl, bg: site.siteBg, active: 'portfolio' });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading homepage.");
  }
});

app.get('/project/:slug', async (req, res) => {
  try {
    const key = req.params.slug;
    let project = toObjects(await db.execute({ sql: "SELECT * FROM projects WHERE slug = ?", args: [key] }))[0];

    if (!project) {
      // A renamed project's old URL, or an old numbered URL like /project/3
      const moved = toObjects(await db.execute({
        sql: "SELECT p.slug FROM slug_redirects r JOIN projects p ON p.id = r.project_id WHERE r.old_slug = ?", args: [key]
      }))[0];
      if (moved) return res.redirect(302, '/project/' + moved.slug);
      if (/^\d+$/.test(key)) {
        const byId = toObjects(await db.execute({ sql: "SELECT slug FROM projects WHERE id = ?", args: [Number(key)] }))[0];
        if (byId && byId.slug) return res.redirect(302, '/project/' + byId.slug);
      }
      return res.status(404).send('Project not found');
    }

    prepareProject(project);
    // Hidden projects are only visible to you while logged in (as a preview)
    if (project.hidden && !req.session.loggedIn) return res.status(404).send('Project not found');

    const others = await db.execute({ sql: `SELECT title, slug, cover_image FROM projects WHERE id != ? AND hidden = 0 ${ORDER}`, args: [project.id] });
    const site = await siteInfo();
    res.render('project', {
      project,
      otherProjects: toObjects(others),
      logoUrl: site.logoUrl,
      bg: project.bg_color || site.siteBg,
      active: 'portfolio',
      isPreview: project.hidden
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading project.");
  }
});

app.get('/contact', async (req, res) => {
  const site = await siteInfo();
  res.render('contact', { logoUrl: site.logoUrl, bg: site.siteBg, active: 'contact', values: {}, errors: {}, sent: req.query.sent === '1' });
});

app.post('/contact', async (req, res) => {
  const values = {
    name: String(req.body.name || '').trim(),
    email: String(req.body.email || '').trim(),
    message: String(req.body.message || '').trim()
  };
  // Hidden "website" field: people never fill it in, spam bots usually do
  if (req.body.website) return res.redirect('/contact?sent=1');

  const errors = {};
  if (!values.name) errors.name = 'Please enter your name.';
  else if (values.name.length > 100) errors.name = 'Please keep your name under 100 characters.';
  if (!values.email) errors.email = 'Please enter your email address.';
  else if (values.email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = 'Please enter a valid email address.';
  if (!values.message) errors.message = 'Please enter a message.';
  else if (values.message.length > 5000) errors.message = 'Please keep your message under 5,000 characters.';

  const site = await siteInfo();
  if (Object.keys(errors).length) {
    return res.status(400).render('contact', { logoUrl: site.logoUrl, bg: site.siteBg, active: 'contact', values, errors, sent: false });
  }
  try {
    await db.execute({
      sql: "INSERT INTO messages (name, email, message, created_at, is_read) VALUES (?, ?, ?, ?, 0)",
      args: [values.name, values.email, values.message, new Date().toISOString()]
    });
    res.redirect('/contact?sent=1');
  } catch (err) {
    console.error("Contact save error:", err);
    errors.form = "Sorry, your message couldn't be sent. Please try again in a minute.";
    res.status(500).render('contact', { logoUrl: site.logoUrl, bg: site.siteBg, active: 'contact', values, errors, sent: false });
  }
});

// ---------------------------------------------------------------------------
// 8. Login + admin page
// ---------------------------------------------------------------------------
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

app.get('/admin', requireLoginPage, async (req, res) => {
  try {
    const projects = toObjects(await db.execute(`SELECT * FROM projects ${ORDER}`)).map(prepareProject);
    const messages = toObjects(await db.execute("SELECT * FROM messages ORDER BY id DESC"))
      .map(m => Object.assign(m, { is_read: Number(m.is_read) === 1 }));
    const site = await siteInfo();
    res.render('admin', {
      projects, messages,
      logoUrl: site.logoUrl, siteBg: site.siteBg, defaultBg: DEFAULT_BG,
      pageWidths: PAGE_WIDTHS, blockGaps: BLOCK_GAPS
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading admin dashboard.");
  }
});

// ---------------------------------------------------------------------------
// 9. Admin APIs (JSON in, JSON out, so the admin page can show real errors)
// ---------------------------------------------------------------------------

// Create a project
app.post('/api/projects', requireLoginApi, async (req, res) => {
  const { title, blocks } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'The project needs a title.' });
  try {
    const cleanBlocks = normalizeBlocks(blocks);
    const slug = await uniqueSlug(title);
    const top = toObjects(await db.execute("SELECT COALESCE(MIN(sort_order), 0) AS m FROM projects"))[0].m;
    await db.execute({
      sql: "INSERT INTO projects (title, cover_image, blocks, slug, hidden, sort_order) VALUES (?, ?, ?, ?, 0, ?)",
      args: [String(title).trim(), firstImage(cleanBlocks), JSON.stringify(cleanBlocks), slug, Number(top) - 1]
    });
    res.json({ ok: true, slug });
  } catch (err) {
    console.error("Project create error:", err);
    res.status(500).json({ error: 'The database rejected the new project: ' + err.message });
  }
});

// Save the homepage order (ids in display order)
app.post('/api/projects/order', requireLoginApi, async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  try {
    for (let i = 0; i < ids.length; i++) {
      await db.execute({ sql: "UPDATE projects SET sort_order = ? WHERE id = ?", args: [i, ids[i]] });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Order save error:", err);
    res.status(500).json({ error: 'The new order could not be saved: ' + err.message });
  }
});

// Show or hide a project on the live site
app.post('/api/projects/:id/visibility', requireLoginApi, async (req, res) => {
  const hidden = req.body && req.body.hidden ? 1 : 0;
  try {
    const result = await db.execute({ sql: "UPDATE projects SET hidden = ? WHERE id = ?", args: [hidden, req.params.id] });
    if (result.rowsAffected === 0) return res.status(404).json({ error: 'This project no longer exists.' });
    res.json({ ok: true, hidden: hidden === 1 });
  } catch (err) {
    console.error("Visibility error:", err);
    res.status(500).json({ error: 'Could not change visibility: ' + err.message });
  }
});

// Save a project from the layout editor
app.post('/api/projects/:id', requireLoginApi, async (req, res) => {
  const { title, description, blocks, cover_image, bg_color, block_gap, content_width } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'The project needs a title.' });

  try {
    const current = toObjects(await db.execute({ sql: "SELECT title, slug FROM projects WHERE id = ?", args: [req.params.id] }))[0];
    if (!current) return res.status(404).json({ error: 'This project no longer exists.' });

    const cleanTitle = String(title).trim();
    const cleanBlocks = normalizeBlocks(blocks);
    const cover = isImageUrl(cover_image) ? cover_image : firstImage(cleanBlocks);
    const bg = isColor(bg_color) ? bg_color : '';
    const gap = pickNumber(block_gap, BLOCK_GAPS, DEFAULT_BLOCK_GAP);
    const width = pickNumber(content_width, PAGE_WIDTHS, DEFAULT_WIDTH);

    // Renamed? Give it a new URL, and keep the old one working as a redirect.
    let slug = current.slug;
    if (cleanTitle !== current.title || !slug) {
      const newSlug = await uniqueSlug(cleanTitle, req.params.id);
      if (newSlug !== slug) {
        if (slug) await db.execute({ sql: "INSERT OR REPLACE INTO slug_redirects (old_slug, project_id) VALUES (?, ?)", args: [slug, req.params.id] });
        await db.execute({ sql: "DELETE FROM slug_redirects WHERE old_slug = ?", args: [newSlug] });
        slug = newSlug;
      }
    }

    await db.execute({
      sql: `UPDATE projects SET title = ?, description = ?, blocks = ?, cover_image = ?, slug = ?, bg_color = ?, block_gap = ?, content_width = ? WHERE id = ?`,
      args: [cleanTitle, description || '', JSON.stringify(cleanBlocks), cover, slug, bg, gap, width, req.params.id]
    });
    res.json({ ok: true, blocks: cleanBlocks, cover_image: cover, slug, bg_color: bg, block_gap: gap, content_width: width });
  } catch (err) {
    console.error("Project save error:", err);
    res.status(500).json({ error: 'The database rejected the save: ' + err.message });
  }
});

app.post('/admin/delete/:id', requireLoginPage, async (req, res) => {
  try {
    await db.execute({ sql: "DELETE FROM projects WHERE id = ?", args: [req.params.id] });
    await db.execute({ sql: "DELETE FROM slug_redirects WHERE project_id = ?", args: [req.params.id] });
    res.redirect('/admin');
  } catch (err) {
    res.status(500).send("Error deleting project.");
  }
});

app.post('/admin/settings/logo', requireLoginPage, async (req, res) => {
  const { logo_url } = req.body;
  if (logo_url) {
    try {
      await db.execute({ sql: "INSERT INTO settings (key, value) VALUES ('logo_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [logo_url] });
    } catch (err) {
      console.error("Logo update error:", err);
    }
  }
  res.redirect('/admin#settings');
});

// Site-wide settings (background color)
app.post('/api/settings', requireLoginApi, async (req, res) => {
  const bg = req.body && req.body.bg_color;
  if (!isColor(bg)) return res.status(400).json({ error: 'Please pick a valid color.' });
  try {
    await db.execute({ sql: "INSERT INTO settings (key, value) VALUES ('bg_color', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [bg] });
    res.json({ ok: true, bg_color: bg });
  } catch (err) {
    console.error("Settings error:", err);
    res.status(500).json({ error: 'Could not save the setting: ' + err.message });
  }
});

// Inbox
app.post('/api/messages/:id/read', requireLoginApi, async (req, res) => {
  const read = req.body && req.body.read === false ? 0 : 1;
  try {
    await db.execute({ sql: "UPDATE messages SET is_read = ? WHERE id = ?", args: [read, req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not update the message: ' + err.message });
  }
});

app.post('/api/messages/:id/delete', requireLoginApi, async (req, res) => {
  try {
    await db.execute({ sql: "DELETE FROM messages WHERE id = ?", args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete the message: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// 10. Vercel Export
// ---------------------------------------------------------------------------
if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, () => console.log('Server running at http://localhost:3000'));
}
module.exports = app;