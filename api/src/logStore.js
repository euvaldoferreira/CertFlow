const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ensureDir() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function saveLog({ source, runId, events }) {
  ensureDir();
  const id = crypto.randomUUID();
  const record = {
    id,
    receivedAt: new Date().toISOString(),
    source: source || 'unknown',
    runId: runId || null,
    eventCount: events.length,
    sites: [...new Set(events.map((e) => e && e.siteKey).filter(Boolean))],
    events,
  };
  fs.writeFileSync(path.join(LOGS_DIR, `${id}.json`), JSON.stringify(record, null, 2));
  return record;
}

function listLogs({ limit = 50 } = {}) {
  ensureDir();
  const files = fs.readdirSync(LOGS_DIR).filter((f) => f.endsWith('.json'));
  const records = files.map((f) => {
    const full = JSON.parse(fs.readFileSync(path.join(LOGS_DIR, f), 'utf8'));
    const { events, ...meta } = full;
    return meta;
  });
  records.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
  return records.slice(0, limit);
}

function getLog(id) {
  if (!isValidId(id)) return null;
  ensureDir();
  const file = path.join(LOGS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function deleteLog(id) {
  if (!isValidId(id)) return false;
  ensureDir();
  const file = path.join(LOGS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/* Junta os eventos de um site específico espalhados pelos lotes mais
   recentes — usado pelo analisador de IA para reconstruir "o que a
   extensão tentou e o que falhou" sem precisar de um banco de dados. */
function getRecentEventsForSite(siteKey, { fileLimit = 30, eventLimit = 60 } = {}) {
  ensureDir();
  const files = fs.readdirSync(LOGS_DIR).filter((f) => f.endsWith('.json'));
  const withMtime = files.map((f) => {
    const full = path.join(LOGS_DIR, f);
    return { full, mtime: fs.statSync(full).mtimeMs };
  });
  withMtime.sort((a, b) => b.mtime - a.mtime);

  const events = [];
  for (const { full } of withMtime.slice(0, fileLimit)) {
    const record = JSON.parse(fs.readFileSync(full, 'utf8'));
    for (const event of record.events || []) {
      if (event && event.siteKey === siteKey) events.push(event);
    }
  }
  events.sort((a, b) => (b.at || 0) - (a.at || 0));
  return events.slice(0, eventLimit);
}

module.exports = { saveLog, listLogs, getLog, deleteLog, isValidId, getRecentEventsForSite };
