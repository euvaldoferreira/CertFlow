const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FEEDBACK_FILE = path.join(DATA_DIR, 'captcha-feedback.jsonl');
const SITE_KEY_RE = /^[a-z0-9_-]{1,32}$/;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function isValidSiteKey(siteKey) {
  return typeof siteKey === 'string' && SITE_KEY_RE.test(siteKey);
}

/* Não é ajuste fino do modelo — nem o Gemini via API nem o Nano on-device
   aprendem a partir de uma chamada individual. Isso é só um registro
   append-only pra revisão humana futura (taxa de acerto real, ajuste de
   prompt) — o mesmo espírito do log de diagnóstico que já alimenta as
   sugestões de seletor em analyzer.js. */
function appendFeedback({ siteKey, texto, success }) {
  ensureDir();
  const record = {
    siteKey: isValidSiteKey(siteKey) ? siteKey : 'desconhecido',
    texto: typeof texto === 'string' ? texto.slice(0, 20) : null,
    success: !!success,
    at: new Date().toISOString(),
  };
  fs.appendFileSync(FEEDBACK_FILE, `${JSON.stringify(record)}\n`);
  return record;
}

function readAll() {
  ensureDir();
  if (!fs.existsSync(FEEDBACK_FILE)) return [];
  return fs
    .readFileSync(FEEDBACK_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        return null;
      }
    })
    .filter(Boolean);
}

function getStats(siteKey) {
  const all = readAll();
  const filtered = siteKey ? all.filter((r) => r.siteKey === siteKey) : all;
  const success = filtered.filter((r) => r.success).length;
  return { total: filtered.length, success, failure: filtered.length - success };
}

module.exports = { appendFeedback, getStats, isValidSiteKey };
