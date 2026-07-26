const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'refresh-tokens.json');
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const MAX_STORED_TOKENS = 200;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/* Nunca guarda o token em texto puro — só o hash, igual a uma senha. Quem
   apresenta o token de volta (POST /api/auth/refresh) precisa conhecer o
   valor original; vazar o arquivo de dados não expõe tokens utilizáveis. */
function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function readAll() {
  ensureDir();
  if (!fs.existsSync(STORE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch (err) {
    return {};
  }
}

function writeAll(records) {
  ensureDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(records, null, 2));
}

/* Sem isso, o arquivo cresceria pra sempre — todo login/refresh grava uma
   entrada nova. Mantém as ainda válidas + as revogadas há menos de 1 dia
   (só pra eventual auditoria de uso indevido logo após revogar), até um
   teto de entradas. */
function pruneExpired(records) {
  const now = Date.now();
  const entries = Object.entries(records).filter(([, r]) => {
    if (r.revokedAt) return now - new Date(r.revokedAt).getTime() < 24 * 60 * 60 * 1000;
    return new Date(r.expiresAt).getTime() > now;
  });
  entries.sort((a, b) => new Date(b[1].createdAt) - new Date(a[1].createdAt));
  return Object.fromEntries(entries.slice(0, MAX_STORED_TOKENS));
}

function createRefreshToken(username) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const records = readAll();
  records[hashToken(rawToken)] = {
    username,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString(),
    lastUsedAt: null,
    revokedAt: null,
  };
  writeAll(pruneExpired(records));
  return { rawToken, expiresIn: Math.floor(REFRESH_TOKEN_TTL_MS / 1000) };
}

/* Retorna o username se o token apresentado for válido (existe, não
   expirou, não foi revogado) — null caso contrário; nunca lança, um
   refresh token ruim é só uma resposta 401 normal pro chamador.

   Revoga o token JÁ NESTA chamada (rotação): cada uso de um refresh token
   emite um par novo e invalida o antigo. Se o mesmo token (por exemplo,
   roubado) for reapresentado depois, já estará revogado — não impede o
   roubo em si, mas detecta o reuso indevido em vez de deixá-lo passar
   silenciosamente pra sempre. */
function consumeRefreshToken(rawToken) {
  if (!rawToken) return null;
  const records = readAll();
  const hash = hashToken(rawToken);
  const record = records[hash];
  if (!record || record.revokedAt || new Date(record.expiresAt).getTime() < Date.now()) return null;

  record.revokedAt = new Date().toISOString();
  record.lastUsedAt = new Date().toISOString();
  writeAll(records);
  return record.username;
}

function revokeRefreshToken(rawToken) {
  if (!rawToken) return;
  const records = readAll();
  const record = records[hashToken(rawToken)];
  if (record && !record.revokedAt) {
    record.revokedAt = new Date().toISOString();
    writeAll(records);
  }
}

module.exports = { createRefreshToken, consumeRefreshToken, revokeRefreshToken };
