require('dotenv').config();
const express = require('express');
const { createClient } = require('@tursodatabase/serverless/compat');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const session = require('cookie-session');
const bcrypt = require('bcrypt');
const path = require('path');
const crypto = require('crypto');
// Global look & feel (CSS tokens) and site copy (contact/footer/SEO), stored in `settings`.
const { sanitizeAppearance, generateSiteCss, siteCssVersion, tintSvg } = require('./lib/appearance');
const { sanitizeContent } = require('./lib/content');

const app = express();
app.disable('x-powered-by');

// Options the admin can pick from (anything else sent to the server is ignored)
const DEFAULT_BG = '#181818';             // site background: a little lighter than the old #111
const PAGE_WIDTHS = [640, 860, 1100, 1400]; // project page width, in pixels
const BLOCK_GAPS = [0, 1, 2, 4];            // space between images on a project page, in rem
const DEFAULT_WIDTH = 1100;
const DEFAULT_BLOCK_GAP = 2;

// Admin login throttling: 5 failures per IP in 15 minutes -> 15 minute lockout. Stored in Turso so
// it works across Vercel's serverless instances.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

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
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
    `CREATE TABLE IF NOT EXISTS slug_redirects (old_slug TEXT PRIMARY KEY, project_id INTEGER)`,
    `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, message TEXT, created_at TEXT, is_read INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER DEFAULT 0, first_at INTEGER DEFAULT 0, blocked_until INTEGER DEFAULT 0)`
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

  // Admin credentials deliberately live in environment variables only (see section 8).
  // Never seed a default username/password into the database again.
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

// Basic security headers. A full CSP is intentionally omitted: the public pages render admin-approved
// embed iframes and the admin page uses inline scripts/styles.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
// Nothing behind the login should be cached or indexed.
app.use(['/admin', '/login', '/api', '/logout'], (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// Keep the login in a signed cookie, not server memory. On Vercel each request can hit a
// different server instance, so in-memory sessions get "forgotten" (→ "Unauthorized").
// The cookie name changed from "session" in the env-credentials release: that deliberately
// invalidates every cookie issued under the old default password.
app.set('trust proxy', 1);
app.use(session({
  name: 'admin_session',
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

// settings values are stored as text; appearance/content are JSON blobs.
const parseSettingJson = (value) => {
  if (typeof value !== 'string' || !value) return null;
  try { return JSON.parse(value); } catch (err) { return null; }
};

// Logo/favicon tinting is only attempted for SVG files uploaded to the R2 bucket.
const isSvgUrl = (url) => {
  try { return /\.svg$/i.test(new URL(String(url)).pathname); } catch (err) { return false; }
};
const tintableUrl = (url) => {
  const base = String(process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
  return !!base && typeof url === 'string' && url.startsWith(base + '/');
};
const tintedBrandUrl = (source, color, kind) => {
  if (!source) return '';
  if (!isColor(color) || !isSvgUrl(source) || !tintableUrl(source)) return source;
  // The salt changes when the tint implementation changes, so previously cached (broken) SVG
  // responses are bypassed immediately instead of waiting out the 1-day cache.
  const v = crypto.createHash('sha1').update(source + '|tint-v2').digest('hex').slice(0, 8);
  return `/brand/${kind}.svg?color=${encodeURIComponent(color)}&v=${v}`;
};

// Values every public page needs: branding, background, generated appearance tokens and site copy.
const getSite = async () => {
  const s = await getSettings();
  const appearance = sanitizeAppearance(parseSettingJson(s.appearance));
  const content = sanitizeContent(parseSettingJson(s.content));
  const rawLogo = s.logo_url || '';
  const rawFavicon = content.seo.favicon || '';
  return {
    logoUrl: tintedBrandUrl(rawLogo, appearance.colors.logo, 'logo'),
    logoIsTinted: !!(appearance.colors.logo && isSvgUrl(rawLogo) && tintableUrl(rawLogo)),
    faviconUrl: tintedBrandUrl(rawFavicon, appearance.colors.favicon, 'favicon'),
    branding: {
      logoUrl: rawLogo,
      faviconUrl: rawFavicon,
      logoIsSvg: isSvgUrl(rawLogo),
      faviconIsSvg: isSvgUrl(rawFavicon)
    },
    siteBg: isColor(s.bg_color) ? s.bg_color : DEFAULT_BG,
    appearance,
    content,
    siteCssVersion: siteCssVersion(appearance),
    currentYear: new Date().getFullYear()
  };
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

// Global appearance tokens (grid columns, type, header, etc). The ?v= query is a hash of the CSS,
// so the immutable cache is safe: any settings change changes the URL.
app.get('/site.css', async (req, res) => {
  try {
    const s = await getSettings();
    const css = generateSiteCss(sanitizeAppearance(parseSettingJson(s.appearance)));
    res.type('text/css').set('Cache-Control', 'public, max-age=31536000, immutable').send(css);
  } catch (err) {
    console.error('Site CSS error:', err);
    res.status(500).type('text/css').send(':root{}');
  }
});

// Recoloured copies of the uploaded SVG logo/favicon. Falls back to the original file when the
// source is not an SVG, the colour is missing, or anything goes wrong.
app.get(['/brand/logo.svg', '/brand/favicon.svg'], async (req, res) => {
  const kind = req.path.indexOf('favicon') !== -1 ? 'favicon' : 'logo';
  let source = '';
  try {
    const s = await getSettings();
    const content = sanitizeContent(parseSettingJson(s.content));
    source = kind === 'logo' ? (s.logo_url || '') : (content.seo.favicon || '');
    const color = isColor(req.query.color) ? String(req.query.color).toLowerCase() : '';
    if (!source) return res.status(404).send('No ' + kind + ' uploaded.');
    if (!color || !isSvgUrl(source) || !tintableUrl(source)) return res.redirect(302, source);

    const upstream = await fetch(source, { signal: AbortSignal.timeout(5000) });
    if (!upstream.ok) return res.redirect(302, source);
    const svg = await upstream.text();
    // The URL extension is already known to be .svg; trust the body over R2's MIME type because
    // some uploads are stored as application/octet-stream even though they are SVGs.
    if (!/<svg\b/i.test(svg)) return res.redirect(302, source);
    if (svg.length > 1024 * 1024) return res.status(413).send('SVG file is too large.');

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    const tinted = tintSvg(svg, color);
    // Safety net: if the recoloured markup is not a clean single SVG document, fall back to the
    // original upload rather than serving a broken icon/logo.
    const openingTag = (tinted.match(/<svg\b[\s\S]*?>/i) || [''])[0];
    if (!openingTag || openingTag.indexOf('<', 1) !== -1 || !/<\/svg>\s*$/i.test(tinted.trim())) {
      return res.redirect(302, source);
    }
    res.send(tinted);
  } catch (err) {
    console.error('Brand tint error:', err.message);
    if (source) return res.redirect(302, source);
    res.status(500).send('Could not load the brand image.');
  }
});

// ---------------------------------------------------------------------------
// 6. Uploads straight to Cloudflare R2 (images never pass through Vercel)
// ---------------------------------------------------------------------------
app.post('/api/upload', requireLoginApi, async (req, res) => {
  const { filename = 'image', contentType } = req.body || {};
  const uniqueFilename = `img-${Date.now()}-${Math.round(Math.random() * 1000)}-${String(filename).replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  // Browsers/OSes sometimes report an empty MIME type. Stamp SVGs correctly so <img>/favicon
  // renders them instead of treating them as octet-streams.
  const safeContentType = contentType || (/\.svg$/i.test(String(filename)) ? 'image/svg+xml' : undefined);
  try {
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: uniqueFilename,
      ContentType: safeContentType,
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
// The About page is the site's front door.
app.get('/', async (req, res) => {
  try {
    const site = await getSite();
    res.render('about', Object.assign({}, site, { bg: site.siteBg, active: 'about' }));
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading the about page.");
  }
});

app.get('/about', (req, res) => res.redirect(302, '/'));

// The project grid moved from / to /portfolio.
app.get('/portfolio', async (req, res) => {
  try {
    const result = await db.execute(`SELECT id, title, slug, cover_image FROM projects WHERE hidden = 0 ${ORDER}`);
    const site = await getSite();
    res.render('index', Object.assign({}, site, { projects: toObjects(result), bg: site.siteBg, active: 'portfolio' }));
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading the portfolio.");
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
    const site = await getSite();
    res.render('project', Object.assign({}, site, {
      project,
      otherProjects: toObjects(others),
      bg: project.bg_color || site.siteBg,
      active: 'portfolio',
      isPreview: project.hidden
    }));
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading project.");
  }
});

app.get('/contact', async (req, res) => {
  const site = await getSite();
  res.render('contact', Object.assign({}, site, { bg: site.siteBg, active: 'contact', values: {}, errors: {}, sent: req.query.sent === '1' }));
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

  const site = await getSite();
  if (Object.keys(errors).length) {
    return res.status(400).render('contact', Object.assign({}, site, { bg: site.siteBg, active: 'contact', values, errors, sent: false }));
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
    res.status(500).render('contact', Object.assign({}, site, { bg: site.siteBg, active: 'contact', values, errors, sent: false }));
  }
});

// ---------------------------------------------------------------------------
// 8. Login + admin page
// ---------------------------------------------------------------------------
// Credentials come ONLY from the environment (Vercel/local .env), never from the database:
//   ADMIN_USERNAME + ADMIN_PASSWORD       - plaintext password, compared in constant time
//   ADMIN_USERNAME + ADMIN_PASSWORD_HASH  - optional bcrypt hash; wins when both are present
// If no password form is configured, login fails closed with a setup message.
const adminCredentials = () => ({
  username: String(process.env.ADMIN_USERNAME || '').trim(),
  password: String(process.env.ADMIN_PASSWORD || ''),
  hash: String(process.env.ADMIN_PASSWORD_HASH || '')
});

// Constant-time string compare (hashing first makes the lengths match).
const safeEqual = (a, b) => {
  const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
};

// Durable throttling: 5 failed attempts per IP in 15 minutes, then a 15 minute lockout.
async function loginThrottle(key) {
  const now = Date.now();
  try {
    const row = toObjects(await db.execute({ sql: "SELECT * FROM login_attempts WHERE key = ?", args: [key] }))[0];
    if (!row) return { blocked: false };
    if (Number(row.blocked_until) > now) return { blocked: true, retryAfter: Number(row.blocked_until) - now };
    if (now - Number(row.first_at) > LOGIN_WINDOW_MS) return { blocked: false };
    return { blocked: false };
  } catch (err) {
    console.error('Login throttle read failed:', err.message);
    return { blocked: false }; // never lock the owner out because the DB read failed
  }
}

async function recordLoginFailure(key) {
  try {
    const now = Date.now();
    const row = toObjects(await db.execute({ sql: "SELECT * FROM login_attempts WHERE key = ?", args: [key] }))[0];
    let count = 1;
    let firstAt = now;
    if (row && now - Number(row.first_at) <= LOGIN_WINDOW_MS) {
      count = (Number(row.count) || 0) + 1;
      firstAt = Number(row.first_at);
    }
    const blockedUntil = count >= LOGIN_MAX_ATTEMPTS ? now + LOGIN_BLOCK_MS : 0;
    await db.execute({
      sql: "INSERT INTO login_attempts (key, count, first_at, blocked_until) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, first_at = excluded.first_at, blocked_until = excluded.blocked_until",
      args: [key, count, firstAt, blockedUntil]
    });
  } catch (err) {
    console.error('Login throttle write failed:', err.message);
  }
}

async function clearLoginFailures(key) {
  try { await db.execute({ sql: "DELETE FROM login_attempts WHERE key = ?", args: [key] }); }
  catch (err) { console.error('Login throttle cleanup failed:', err.message); }
}

const loginKey = (req) => String(req.ip || req.headers['x-forwarded-for'] || 'unknown').slice(0, 80);

app.get('/login', (req, res) => {
  if (req.session.loggedIn) return res.redirect('/admin');
  res.render('login', { error: '' });
});

app.post('/login', async (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const creds = adminCredentials();
  if (!creds.username || (!creds.password && !creds.hash)) {
    console.error('Admin login is not configured: set ADMIN_USERNAME and ADMIN_PASSWORD (or ADMIN_PASSWORD_HASH).');
    return res.status(503).render('login', {
      error: 'Admin login is not configured yet. Add ADMIN_USERNAME and ADMIN_PASSWORD to the Vercel environment variables, then redeploy.'
    });
  }

  const key = loginKey(req);
  const throttle = await loginThrottle(key);
  if (throttle.blocked) {
    const minutes = Math.max(1, Math.ceil(throttle.retryAfter / 60000));
    return res.status(429).render('login', { error: `Too many failed attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.` });
  }

  // Evaluate both checks on every request so a wrong username is not faster than a wrong password.
  const usernameOk = safeEqual(String(username).trim(), creds.username);
  let passwordOk = false;
  try {
    passwordOk = creds.hash
      ? bcrypt.compareSync(String(password), creds.hash)
      : safeEqual(String(password), creds.password);
  } catch (err) {
    // A malformed ADMIN_PASSWORD_HASH must fail closed, never crash the login route.
    console.error('Admin password check failed (check ADMIN_PASSWORD_HASH):', err.message);
  }

  if (usernameOk && passwordOk) {
    await clearLoginFailures(key);
    req.session = { loggedIn: true, user: creds.username, at: Date.now() };
    return res.redirect('/admin');
  }

  await recordLoginFailure(key);
  await new Promise(resolve => setTimeout(resolve, 350)); // speed bump on top of the lockout
  return res.status(401).render('login', { error: 'That username or password is not correct.' });
});

app.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

app.get('/admin', requireLoginPage, async (req, res) => {
  try {
    const projects = toObjects(await db.execute(`SELECT * FROM projects ${ORDER}`)).map(prepareProject);
    const messages = toObjects(await db.execute("SELECT * FROM messages ORDER BY id DESC"))
      .map(m => Object.assign(m, { is_read: Number(m.is_read) === 1 }));
    const site = await getSite();
    const creds = adminCredentials();
    // Read-only status for the admin's Security card. Never exposes the secret values themselves.
    let legacyUsers = 0;
    try { legacyUsers = Number(toObjects(await db.execute("SELECT COUNT(*) AS n FROM users"))[0].n) || 0; } catch (err) { /* table may not exist */ }
    res.render('admin', {
      projects, messages,
      logoUrl: site.logoUrl, siteBg: site.siteBg, defaultBg: DEFAULT_BG,
      pageWidths: PAGE_WIDTHS, blockGaps: BLOCK_GAPS,
      appearance: site.appearance, content: site.content,
      branding: site.branding,
      securityStatus: {
        adminUserConfigured: !!creds.username,
        adminPasswordConfigured: !!(creds.password || creds.hash),
        sessionSecretConfigured: !!process.env.SESSION_SECRET,
        legacyUsers
      }
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
    // New projects inherit the global defaults from Admin > Site Settings > Project pages.
    const site = await getSite();
    const width = site.appearance.project.defaultWidth;
    const gap = site.appearance.project.defaultGap;
    await db.execute({
      sql: "INSERT INTO projects (title, cover_image, blocks, slug, hidden, sort_order, content_width, block_gap) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
      args: [String(title).trim(), firstImage(cleanBlocks), JSON.stringify(cleanBlocks), slug, Number(top) - 1, width, gap]
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

// Site-wide visual settings: homepage grid, typography, header, project-page defaults.
app.post('/api/settings/appearance', requireLoginApi, async (req, res) => {
  const raw = req.body && req.body.appearance;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return res.status(400).json({ error: 'No appearance settings were sent.' });
  }
  try {
    const appearance = sanitizeAppearance(raw);
    await db.execute({
      sql: "INSERT INTO settings (key, value) VALUES ('appearance', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      args: [JSON.stringify(appearance)]
    });
    res.json({ ok: true, appearance, version: siteCssVersion(appearance) });
  } catch (err) {
    console.error('Appearance save error:', err);
    res.status(500).json({ error: 'Could not save the appearance settings: ' + err.message });
  }
});

// Site-wide content: contact copy, footer + social links, SEO/sharing metadata.
app.post('/api/settings/content', requireLoginApi, async (req, res) => {
  const raw = req.body && req.body.content;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return res.status(400).json({ error: 'No site content was sent.' });
  }
  try {
    const content = sanitizeContent(raw);
    await db.execute({
      sql: "INSERT INTO settings (key, value) VALUES ('content', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      args: [JSON.stringify(content)]
    });
    res.json({ ok: true, content });
  } catch (err) {
    console.error('Content save error:', err);
    res.status(500).json({ error: 'Could not save the content: ' + err.message });
  }
});

// Duplicate a project (copy + layout) so it can be used as a starting point.
app.post('/api/projects/:id/duplicate', requireLoginApi, async (req, res) => {
  try {
    const source = toObjects(await db.execute({ sql: "SELECT * FROM projects WHERE id = ?", args: [req.params.id] }))[0];
    if (!source) return res.status(404).json({ error: 'This project no longer exists.' });
    const title = String(source.title || 'Untitled') + ' (copy)';
    const slug = await uniqueSlug(title);
    const top = toObjects(await db.execute("SELECT COALESCE(MIN(sort_order), 0) AS m FROM projects"))[0].m;
    await db.execute({
      sql: `INSERT INTO projects (title, cover_image, description, blocks, slug, hidden, sort_order, bg_color, block_gap, content_width)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      args: [
        title, source.cover_image || '', source.description || '', source.blocks || '[]', slug, Number(top) - 1,
        source.bg_color || '',
        source.block_gap === null || source.block_gap === undefined || source.block_gap === '' ? DEFAULT_BLOCK_GAP : Number(source.block_gap),
        source.content_width === null || source.content_width === undefined || source.content_width === '' ? DEFAULT_WIDTH : Number(source.content_width)
      ]
    });
    const created = toObjects(await db.execute({ sql: "SELECT id, slug FROM projects WHERE slug = ?", args: [slug] }))[0];
    res.json({ ok: true, id: created.id, slug: created.slug });
  } catch (err) {
    console.error('Project duplicate error:', err);
    res.status(500).json({ error: 'Could not duplicate the project: ' + err.message });
  }
});

// Download a JSON backup of the content (no contact-inbox messages, for privacy).
app.get('/admin/backup.json', requireLoginPage, async (req, res) => {
  try {
    const [projects, settings, redirects] = await Promise.all([
      db.execute(`SELECT * FROM projects ${ORDER}`),
      db.execute("SELECT * FROM settings"),
      db.execute("SELECT * FROM slug_redirects").catch(() => ({ rows: [], columns: [] }))
    ]);
    const payload = {
      exported_at: new Date().toISOString(),
      projects: toObjects(projects),
      settings: toObjects(settings),
      slug_redirects: toObjects(redirects)
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="portfolio-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).send('Could not create the backup.');
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