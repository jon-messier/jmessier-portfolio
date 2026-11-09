// Global appearance settings: defaults, validation, and the generated /site.css.
// Everything visual on the public site is driven by CSS custom properties produced here, so the
// admin can restyle the site without a code change or redeploy.
const crypto = require('crypto');

const DEFAULT_APPEARANCE = {
  home: {
    columns: 3,
    columnsMobile: 1,
    maxWidth: -1,
    gapX: 2,
    gapY: 4,
    coverRatio: '4/3',
    coverFit: 'cover',
    titleSize: 1,
    titleWeight: 400,
    showTitles: true
  },
  project: {
    titleSize: 2.5,
    descriptionWidth: 600,
    defaultWidth: 1100,
    defaultGap: 2,
    carouselShow: true,
    carouselItemWidth: 280,
    carouselCoverRatio: '4/3'
  },
  type: {
    font: 'open-sans',
    scale: 1,
    headingWeight: 600,
    navSize: 0.85,
    navSpacing: 1.5,
    navUppercase: true,
    displayFont: 'site'
  },
  header: {
    layout: 'nav-left',
    logoHeight: 40,
    paddingY: 1.5,
    paddingX: 4,
    sticky: true
  },
  colors: {
    navActive: '#ff5a36',
    titleHover: '#ff5a36',
    logo: '',
    favicon: ''
  }
};

const DISPLAY_FONT = "'Instrument Serif', Georgia, 'Times New Roman', serif";

const FONTS = ['open-sans', 'inter', 'source-sans', 'georgia', 'system'];
const FONT_STACKS = {
  'open-sans': "'Open Sans', sans-serif",
  inter: "'Inter', sans-serif",
  'source-sans': "'Source Sans 3', sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const section = (raw, key) => (isObject(raw) && isObject(raw[key]) ? raw[key] : {});

const pickEnum = (value, allowed, fallback) => {
  const n = typeof value === 'number' ? value : Number(value);
  return allowed.includes(n) ? n : fallback;
};
const pickString = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const bool = (value, fallback) => (value === true ? true : value === false ? false : fallback);
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const isHexColor = (value) => typeof value === 'string' && HEX_COLOR.test(value);
const clamp = (value, min, max, fallback, step) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  let out = Math.min(max, Math.max(min, n));
  if (step) out = Math.round(out / step) * step;
  // Avoid 0.30000000000000004-style output from the step rounding
  return Math.round(out * 1000) / 1000;
};

// Turns anything that arrives from the admin API into a safe, complete appearance object.
function sanitizeAppearance(raw) {
  const out = clone(DEFAULT_APPEARANCE);
  if (!isObject(raw)) return out;

  const home = section(raw, 'home');
  out.home.columns = clamp(home.columns, 1, 4, out.home.columns, 1);
  out.home.columnsMobile = clamp(home.columnsMobile, 1, 2, out.home.columnsMobile, 1);
  out.home.maxWidth = pickEnum(home.maxWidth, [-1, 0, 860, 1100, 1300, 1500], out.home.maxWidth);
  out.home.gapX = clamp(home.gapX, 0, 4, out.home.gapX, 0.5);
  out.home.gapY = clamp(home.gapY, 1, 6, out.home.gapY, 0.5);
  out.home.coverRatio = pickString(home.coverRatio, ['4/3', '3/2', '16/9', '1/1', 'natural'], out.home.coverRatio);
  out.home.coverFit = pickString(home.coverFit, ['cover', 'contain'], out.home.coverFit);
  out.home.titleSize = clamp(home.titleSize, 0.8, 1.6, out.home.titleSize, 0.05);
  out.home.titleWeight = pickEnum(home.titleWeight, [400, 600, 700], out.home.titleWeight);
  out.home.showTitles = bool(home.showTitles, out.home.showTitles);

  const project = section(raw, 'project');
  out.project.titleSize = clamp(project.titleSize, 1.6, 3.2, out.project.titleSize, 0.1);
  out.project.descriptionWidth = clamp(project.descriptionWidth, 420, 860, out.project.descriptionWidth, 20);
  out.project.defaultWidth = pickEnum(project.defaultWidth, [640, 860, 1100, 1400], out.project.defaultWidth);
  out.project.defaultGap = pickEnum(project.defaultGap, [0, 1, 2, 4], out.project.defaultGap);
  out.project.carouselShow = bool(project.carouselShow, out.project.carouselShow);
  out.project.carouselItemWidth = clamp(project.carouselItemWidth, 200, 360, out.project.carouselItemWidth, 10);
  out.project.carouselCoverRatio = pickString(project.carouselCoverRatio, ['4/3', '3/2', '16/9', '1/1'], out.project.carouselCoverRatio);

  const type = section(raw, 'type');
  out.type.font = pickString(type.font, FONTS, out.type.font);
  out.type.scale = clamp(type.scale, 0.9, 1.15, out.type.scale, 0.01);
  out.type.headingWeight = pickEnum(type.headingWeight, [500, 600, 700], out.type.headingWeight);
  out.type.navSize = clamp(type.navSize, 0.7, 1, out.type.navSize, 0.01);
  out.type.navSpacing = clamp(type.navSpacing, 0, 3, out.type.navSpacing, 0.5);
  out.type.navUppercase = bool(type.navUppercase, out.type.navUppercase);
  // About-page display typography: 'site' follows the site body font, the other keeps Instrument Serif.
  out.type.displayFont = pickString(type.displayFont, ['site', 'instrument-serif'], out.type.displayFont);

  const header = section(raw, 'header');
  out.header.layout = pickString(header.layout, ['nav-left', 'logo-left'], out.header.layout);
  out.header.logoHeight = clamp(header.logoHeight, 24, 72, out.header.logoHeight, 1);
  out.header.paddingY = clamp(header.paddingY, 0.75, 2.5, out.header.paddingY, 0.25);
  out.header.paddingX = clamp(header.paddingX, 1, 5, out.header.paddingX, 0.25);
  out.header.sticky = bool(header.sticky, out.header.sticky);

  // Accent colours. navActive/titleHover always have a value; logo/favicon only tint SVG uploads
  // and are empty when the original artwork colour should be kept.
  const colors = section(raw, 'colors');
  out.colors.navActive = isHexColor(colors.navActive) ? colors.navActive.toLowerCase() : out.colors.navActive;
  out.colors.titleHover = isHexColor(colors.titleHover) ? colors.titleHover.toLowerCase() : out.colors.titleHover;
  out.colors.logo = isHexColor(colors.logo) ? colors.logo.toLowerCase() : '';
  out.colors.favicon = isHexColor(colors.favicon) ? colors.favicon.toLowerCase() : '';

  return out;
}

// "4/3" -> "4 / 3"; "natural" -> "auto"
const ratioCss = (ratio) => (ratio === 'natural' ? 'auto' : String(ratio).replace('/', ' / '));

function generateSiteCss(appearance) {
  const a = sanitizeAppearance(appearance);
  const lines = [
    '/* Generated from Admin > Site Settings. Edit the settings, not this file. */',
    "@import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@300;400;500;600;700&family=Open+Sans:wght@300;400;600;700&family=Source+Sans+3:wght@300;400;500;600;700&display=swap');",
    ':root {',
    `  --font-body: ${FONT_STACKS[a.type.font]};`,
    `  --font-display: ${a.type.displayFont === 'site' ? FONT_STACKS[a.type.font] : DISPLAY_FONT};`,
    `  --font-size: ${Math.round(16 * a.type.scale * 100) / 100}px;`,
    `  --heading-weight: ${a.type.headingWeight};`,
    `  --nav-size: ${a.type.navSize}rem;`,
    `  --nav-spacing: ${a.type.navSpacing}px;`,
    `  --nav-transform: ${a.type.navUppercase ? 'uppercase' : 'none'};`,
    `  --nav-active-color: ${a.colors.navActive};`,
    `  --title-hover-color: ${a.colors.titleHover};`,
    `  --accent: ${a.colors.navActive};`,
    `  --logo-height: ${a.header.logoHeight}px;`,
    `  --header-position: ${a.header.sticky ? 'sticky' : 'static'};`,
    `  --header-pad-y: ${a.header.paddingY}rem;`,
    `  --header-pad-x: ${a.header.paddingX}rem;`,
    `  --home-cols: ${a.home.columns};`,
    `  --home-cols-mobile: ${a.home.columnsMobile};`,
    `  --home-max: ${a.home.maxWidth === -1 ? 'calc(80vw + 3rem)' : a.home.maxWidth === 0 ? 'none' : a.home.maxWidth + 'px'};`,
    `  --home-gap-x: ${a.home.gapX}rem;`,
    `  --home-gap-y: ${a.home.gapY}rem;`,
    `  --home-cover-ratio: ${ratioCss(a.home.coverRatio)};`,
    `  --home-cover-fit: ${a.home.coverFit};`,
    `  --home-title-size: ${a.home.titleSize}rem;`,
    `  --home-title-weight: ${a.home.titleWeight};`,
    `  --home-title-display: ${a.home.showTitles ? 'block' : 'none'};`,
    `  --project-title-size: ${a.project.titleSize}rem;`,
    `  --project-desc-width: ${a.project.descriptionWidth}px;`,
    `  --carousel-item-width: ${a.project.carouselItemWidth}px;`,
    `  --carousel-cover-ratio: ${ratioCss(a.project.carouselCoverRatio)};`,
    '}',
    ''
  ];
  return lines.join('\n');
}

// Changing any setting changes the URL of /site.css, so the long cache is always safe.
function siteCssVersion(appearance) {
  return crypto.createHash('sha1').update(generateSiteCss(appearance)).digest('hex').slice(0, 10);
}

// Removes active content from an SVG before it is served back as an image.
function sanitizeSvg(svg) {
  return String(svg || '')
    .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<\s*foreignObject[\s\S]*?<\s*\/\s*foreignObject\s*>/gi, '')
    .replace(/<\s*iframe[\s\S]*?<\s*\/\s*iframe\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/javascript\s*:/gi, '');
}

// Recolours an uploaded SVG. Uses currentColor when the artwork provides it, otherwise forces the
// tint on the shape elements (best for single-colour logos and favicons).
function tintSvg(svg, color) {
  let out = sanitizeSvg(svg);
  if (!isHexColor(color)) return out;
  if (/currentColor/i.test(out)) {
    return out.replace(/currentColor/gi, color);
  }
  out = out.replace(/<svg\b([^>]*)>/i, (match, attrs) => (
    /fill\s*=/i.test(attrs) ? `<svg${attrs}` : `<svg${attrs} fill="${color}"`
  ));
  const tintStyle = `<style>svg :not([fill="none"]):not([fill^="url("]){fill:${color} !important}svg [fill="none"]{fill:none !important}svg [stroke]:not([stroke="none"]):not([stroke^="url("]){stroke:${color} !important}</style>`;
  return out.replace(/<\/svg>/i, tintStyle + '</svg>');
}

module.exports = {
  DEFAULT_APPEARANCE,
  FONTS,
  sanitizeAppearance,
  generateSiteCss,
  siteCssVersion,
  sanitizeSvg,
  tintSvg
};
