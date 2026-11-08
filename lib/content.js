// Global site content: contact copy, footer + social links, and SEO/sharing metadata.
// Kept separate from "appearance" because it is text/URLs rather than CSS values.
const DEFAULT_CONTENT = {
  seo: {
    siteName: 'Jon Messier',
    homeTitle: 'Jon Messier | Portfolio',
    description: '',
    ogImage: '',
    favicon: ''
  },
  contact: {
    heading: 'Contact',
    intro: "Have a project in mind or a question? Send a message and I'll get back to you.",
    success: 'Thanks! Your message was sent.',
    email: ''
  },
  footer: {
    show: true,
    text: '',
    social: []
  }
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const section = (raw, key) => (isObject(raw) && isObject(raw[key]) ? raw[key] : {});

const cleanText = (value, max, fallback = '') => {
  if (typeof value !== 'string') return fallback;
  return value.replace(/\r\n/g, '\n').trim().slice(0, max);
};
const cleanUrl = (value) => {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url) return '';
  if (url.length > 500 || !/^https?:\/\/[^\s]+$/i.test(url)) return '';
  return url;
};
const email = (value) => {
  const out = cleanText(value, 200);
  return !out || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out) ? out : '';
};

function sanitizeFooterSocial(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 4)
    .map((item) => (isObject(item) ? { label: cleanText(item.label, 40), url: cleanUrl(item.url) } : null))
    .filter((item) => item && item.label && item.url);
}

function sanitizeContent(raw) {
  const out = clone(DEFAULT_CONTENT);
  if (!isObject(raw)) return out;

  const seo = section(raw, 'seo');
  out.seo.siteName = cleanText(seo.siteName, 120) || out.seo.siteName;
  out.seo.homeTitle = cleanText(seo.homeTitle, 160, out.seo.homeTitle);
  out.seo.description = cleanText(seo.description, 300);
  out.seo.ogImage = cleanUrl(seo.ogImage);
  out.seo.favicon = cleanUrl(seo.favicon);

  const contact = section(raw, 'contact');
  out.contact.heading = cleanText(contact.heading, 80) || out.contact.heading;
  out.contact.intro = cleanText(contact.intro, 600, out.contact.intro);
  out.contact.success = cleanText(contact.success, 300) || out.contact.success;
  out.contact.email = email(contact.email);

  const footer = section(raw, 'footer');
  out.footer.show = footer.show === false ? false : true;
  out.footer.text = cleanText(footer.text, 200);
  out.footer.social = sanitizeFooterSocial(footer.social);

  return out;
}

module.exports = { DEFAULT_CONTENT, sanitizeContent };
