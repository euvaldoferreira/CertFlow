const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

/* Access token curto (15-30min, aqui 20) — assinado (JWT), nunca guardado
   no servidor: validar é só verificar a assinatura. O que precisa ficar
   revogável (refresh token, validade de dias) mora em refreshTokenStore.js,
   guardado com hash, nunca em texto puro. */
const ACCESS_TOKEN_TTL = '20m';
const ACCESS_TOKEN_TTL_SECONDS = 20 * 60;
const SCOPE = 'certflow:use';

function getSecret() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error('JWT_ACCESS_SECRET não configurado no servidor.');
  return secret;
}

/* bcrypt.compare já roda em tempo constante em relação ao HASH (evita
   timing attack sobre a senha) — a senha em si nunca é guardada, só o
   hash configurado em ADMIN_PASSWORD_HASH. */
async function verifyCredentials(username, password) {
  const expectedUsername = process.env.ADMIN_USERNAME;
  const expectedHash = process.env.ADMIN_PASSWORD_HASH;
  if (!expectedUsername || !expectedHash) return false;
  if (username !== expectedUsername) return false;
  return bcrypt.compare(password, expectedHash);
}

function signAccessToken(username) {
  const token = jwt.sign({ scope: SCOPE }, getSecret(), {
    subject: username,
    expiresIn: ACCESS_TOKEN_TTL,
  });
  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/* Middleware que substitui a antiga chave estática compartilhada — cada
   requisição carrega um JWT de curta duração, verificado por assinatura
   (sem consulta a nenhum armazenamento). "code" no corpo do erro deixa o
   cliente (extensão) distinguir "token expirado" (vale tentar renovar via
   refresh token) de "token inválido"/ausente (precisa logar de novo). */
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) {
    return res.status(401).json({ error: 'Não autorizado.', code: 'missing_token' });
  }
  try {
    const payload = jwt.verify(token, getSecret());
    req.user = { username: payload.sub, scope: payload.scope };
    next();
  } catch (err) {
    const code = err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token';
    res.status(401).json({ error: 'Token inválido ou expirado.', code });
  }
}

module.exports = { verifyCredentials, signAccessToken, requireAuth, ACCESS_TOKEN_TTL_SECONDS };
