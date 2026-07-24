const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SUGGESTIONS_DIR = path.join(DATA_DIR, 'suggestions');
const SITE_KEY_RE = /^[a-z0-9_-]{1,32}$/;

function ensureDir() {
  fs.mkdirSync(SUGGESTIONS_DIR, { recursive: true });
}

function isValidSiteKey(siteKey) {
  return typeof siteKey === 'string' && SITE_KEY_RE.test(siteKey);
}

function saveSuggestion(siteKey, suggestion) {
  if (!isValidSiteKey(siteKey)) throw new Error('siteKey inválido.');
  ensureDir();
  const record = { siteKey, ...suggestion, generatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(SUGGESTIONS_DIR, `${siteKey}.json`), JSON.stringify(record, null, 2));
  return record;
}

function getSuggestion(siteKey) {
  if (!isValidSiteKey(siteKey)) return null;
  ensureDir();
  const file = path.join(SUGGESTIONS_DIR, `${siteKey}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = { saveSuggestion, getSuggestion, isValidSiteKey, SITE_KEY_RE };
