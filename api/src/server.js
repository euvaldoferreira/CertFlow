require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { saveLog, listLogs, getLog, deleteLog, isValidId, getRecentEventsForSite } = require('./logStore');
const { saveSuggestion, getSuggestion, isValidSiteKey } = require('./suggestionStore');
const { analyzeSite } = require('./analyzer');
const { solveCaptchaImage } = require('./captcha');
const { appendFeedback, getStats } = require('./captchaFeedbackStore');
const { requireApiKey } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');

/* Log de requisição simples — sem isso não há como saber, olhando
   `docker logs`, se algo bateu na API e foi rejeitado (401/400) ou se
   simplesmente não chegou nada. */
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'certflow-api', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({
    service: 'CertFlow API',
    endpoints: {
      'POST /api/logs': 'Recebe um lote de eventos do log de navegação da extensão.',
      'GET /api/logs': 'Lista os lotes recebidos (metadados, sem o conteúdo completo).',
      'GET /api/logs/:id': 'Detalha um lote específico.',
      'DELETE /api/logs/:id': 'Remove um lote.',
      'POST /api/analyze': 'Pede à IA para sugerir seletores a partir dos logs recentes de um site.',
      'GET /api/suggestions/:siteKey': 'Última sugestão de seletores gerada para um site.',
      'POST /api/captcha/solve': 'Pede à IA (Gemini) para ler o texto de uma imagem de captcha.',
      'POST /api/captcha/feedback': 'Registra se a leitura de captcha da IA acertou ou não (revisão futura, não é aprendizado do modelo).',
      'GET /api/captcha/feedback/stats': 'Taxa de acerto registrada até agora (opcionalmente por site).',
    },
  });
});

app.post('/api/logs', requireApiKey, (req, res) => {
  const { source, runId, events } = req.body || {};
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: '"events" deve ser um array não vazio.' });
  }
  const record = saveLog({ source, runId, events });
  const { events: _omit, ...meta } = record;
  res.status(201).json(meta);

  /* Auto-analisa em segundo plano (não atrasa a resposta) quando o próprio
     lote já indica que algum campo não foi encontrado — assim a sugestão
     costuma estar pronta antes da próxima execução do mesmo site. */
  const brokenSites = new Set(
    events.filter((e) => e && typeof e.step === 'string' && e.step.endsWith('_missing')).map((e) => e.siteKey).filter(isValidSiteKey)
  );
  for (const siteKey of brokenSites) {
    Promise.resolve()
      .then(() => analyzeSite(siteKey, getRecentEventsForSite(siteKey)))
      .then((result) => {
        if (result) saveSuggestion(siteKey, result);
      })
      .catch((err) => console.error(`auto-analyze falhou para ${siteKey}:`, err.message || err));
  }
});

app.post('/api/analyze', requireApiKey, async (req, res) => {
  const { siteKey } = req.body || {};
  if (!isValidSiteKey(siteKey)) return res.status(400).json({ error: 'siteKey inválido.' });
  try {
    const events = getRecentEventsForSite(siteKey);
    const result = await analyzeSite(siteKey, events);
    if (!result) {
      return res.status(422).json({ error: 'Sem retrato de página recente para analisar este site — rode a extensão uma vez primeiro.' });
    }
    res.json(saveSuggestion(siteKey, result));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: `Falha ao consultar a IA: ${err.message || err}` });
  }
});

app.get('/api/suggestions/:siteKey', requireApiKey, (req, res) => {
  if (!isValidSiteKey(req.params.siteKey)) return res.status(400).json({ error: 'siteKey inválido.' });
  const record = getSuggestion(req.params.siteKey);
  if (!record) return res.status(404).json({ error: 'Nenhuma sugestão disponível ainda.' });
  res.json(record);
});

app.post('/api/captcha/solve', requireApiKey, async (req, res) => {
  const { imageBase64, mime } = req.body || {};
  if (typeof imageBase64 !== 'string' || !imageBase64) {
    return res.status(400).json({ error: '"imageBase64" é obrigatório.' });
  }
  try {
    const result = await solveCaptchaImage(imageBase64, mime);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: `Falha ao consultar a IA: ${err.message || err}` });
  }
});

app.post('/api/captcha/feedback', requireApiKey, (req, res) => {
  const { siteKey, texto, success } = req.body || {};
  if (typeof siteKey !== 'string') return res.status(400).json({ error: 'siteKey é obrigatório.' });
  res.status(201).json(appendFeedback({ siteKey, texto, success }));
});

app.get('/api/captcha/feedback/stats', requireApiKey, (req, res) => {
  res.json(getStats(req.query.siteKey));
});

app.get('/api/logs', requireApiKey, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(listLogs({ limit }));
});

app.get('/api/logs/:id', requireApiKey, (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'id inválido.' });
  const record = getLog(req.params.id);
  if (!record) return res.status(404).json({ error: 'não encontrado.' });
  res.json(record);
});

app.delete('/api/logs/:id', requireApiKey, (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'id inválido.' });
  const removed = deleteLog(req.params.id);
  if (!removed) return res.status(404).json({ error: 'não encontrado.' });
  res.status(204).end();
});

app.use((req, res) => res.status(404).json({ error: 'rota não encontrada' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido.' });
  }
  console.error(err);
  res.status(500).json({ error: 'erro interno' });
});

app.listen(PORT, () => {
  console.log(`CertFlow API ouvindo na porta ${PORT}`);
});
