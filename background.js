/* Orquestra a execução: cada CNPJ é uma execução independente (runs[cnpj]),
   e cada execução abre uma aba para cada certidão selecionada — todas de
   uma vez, em paralelo, sem uma esperar a outra terminar — manda o content
   script preencher o CNPJ (quando o site permite automação sem login),
   aguarda captcha/resultado e salva o PDF gerado (ou confirma envio por
   e-mail, dependendo do site). Uma certidão falhar não afeta as outras, e
   uma execução (CNPJ) inteira falhar não afeta outra execução em paralelo
   para um CNPJ diferente. No Firefox, CNPJUtil vem de lib/cnpj.js
   carregado antes deste arquivo pelo manifest ("background.scripts"). No
   Chrome, este arquivo roda sozinho como service worker (MV3 só aceita um
   "service_worker"), então ele mesmo importa lib/cnpj.js — só faz sentido
   nesse contexto, por isso o guard. */
const IS_SERVICE_WORKER = typeof importScripts === 'function';
if (IS_SERVICE_WORKER) {
  importScripts('lib/browser-shim.js', 'lib/cnpj.js');
}

const NOTIFICATION_ICON = IS_SERVICE_WORKER ? 'icons/chrome/icon-128.png' : 'icons/icon.svg';
const UNAVAILABLE_RETRY_DELAY_MS = 30 * 1000;
const UNAVAILABLE_MAX_RETRIES = 3;
const MAX_STORED_TERMINAL_RUNS = 10;

/* mode "auto": a extensão preenche CNPJ e opera o site sozinha.
   mode "manual": o site exige login (gov.br) — a extensão só abre a aba e
   espera o usuário fazer o resto; conclui quando a aba é fechada. */
const SITES = {
  rfb: {
    label: 'Receita Federal - Certidão de Regularidade Fiscal',
    fileTag: 'RFB-certidao-regularidade-fiscal',
    url: 'https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj',
    mode: 'auto',
  },
  caixa: {
    label: 'Caixa - Certificado de Regularidade do FGTS',
    fileTag: 'Caixa-CRF-FGTS',
    url: 'https://consulta-crf.caixa.gov.br/consultacrf/pages/consultaEmpregador.jsf',
    mode: 'auto',
  },
  cndt: {
    label: 'TST - Certidão Negativa de Débitos Trabalhistas (CNDT)',
    fileTag: 'CNDT-TST',
    url: 'https://cndt-certidao.tst.jus.br/gerarCertidao.faces',
    mode: 'auto',
    delivery: 'email', // não gera arquivo pra baixar — o site manda por e-mail
  },
  simples: {
    label: 'Simples Nacional - Consulta Optantes',
    fileTag: 'SimplesNacional-consulta-optantes',
    /* A página oficial (simplesnacional/aplicacoes.aspx?id=21) só carrega o
       formulário dentro de um iframe que começa com display:none e depende
       de JS do próprio site (EscondeElementos()) pra aparecer — frágil
       demais pra automação. Vai direto ao formulário real, que é uma
       página HTML simples sem iframe nem redirecionamento. */
    url: 'https://consopt.www8.receita.fazenda.gov.br/consultaoptantes',
    mode: 'auto',
  },
};
const DEFAULT_SELECTED_SITES = ['rfb', 'caixa'];

/* Antes só existia UMA execução por vez (currentRun) — abrir o popup e
   tentar emitir um CNPJ novo enquanto outro ainda rodava era bloqueado
   ("já existe uma execução em andamento"). Agora runs é um mapa por CNPJ:
   cada CNPJ é uma execução totalmente independente, cada uma com suas
   próprias abas/jobs/log, sem uma bloquear ou interferir na outra. Só
   iniciar DUAS vezes o MESMO CNPJ enquanto a primeira ainda roda é que
   continua bloqueado (ver startRun). */
let runs = {};
let hydrated = false;

/* Serializa as escritas em storage.local.debugLog: sem isso, duas
   mensagens DEBUG_LOG chegando próximas (ex.: dois recordDebug() seguidos
   sem await no content script) fazem um get→push→set clássico de corrida
   — os dois handlers leem o mesmo array antes de qualquer um escrever de
   volta, e o segundo set() sobrescreve o primeiro, perdendo um evento
   silenciosamente. Confirmado num log real onde um evento sumiu. */
let debugLogWriteChain = Promise.resolve();
function appendDebugLogEntry(entry) {
  debugLogWriteChain = debugLogWriteChain
    .then(async () => {
      const { debugLog = [] } = await browser.storage.local.get('debugLog');
      debugLog.push(entry);
      await browser.storage.local.set({ debugLog: debugLog.slice(-300) });
    })
    .catch(() => {});
  return debugLogWriteChain;
}

/* Um popup padrão (default_popup) é ancorado pelo próprio navegador perto
   do ícone da extensão — não dá pra reposicionar nem redimensionar por
   CSS. Por isso o manifest não declara default_popup: o clique no ícone
   cai aqui, e abrimos a mesma popup/popup.html como uma janela normal,
   centralizada e ocupando metade da tela. Cada clique (ou cada item do
   menu de contexto) abre uma janela NOVA e independente — sem reaproveitar
   uma já aberta — pra permitir acompanhar várias execuções em paralelo,
   uma por janela. */
async function getScreenBounds() {
  try {
    if (browser.system && browser.system.display && browser.system.display.getInfo) {
      const displays = await browser.system.display.getInfo();
      const primary = displays.find((d) => d.isPrimary) || displays[0];
      if (primary) return primary.workArea || primary.bounds;
    }
  } catch (err) {
    /* system.display pode não estar disponível (permissão negada, versão
       antiga do navegador) — cai no fallback abaixo em vez de travar. */
  }
  const current = await browser.windows.getCurrent();
  return { left: 0, top: 0, width: current.width || 1280, height: current.height || 800 };
}

async function openPopupWindow(prefillCnpj) {
  const bounds = await getScreenBounds();
  const width = Math.round(bounds.width * 0.5);
  const height = Math.round(bounds.height * 0.5);
  const left = Math.round((bounds.left || 0) + (bounds.width - width) / 2);
  const top = Math.round((bounds.top || 0) + (bounds.height - height) / 2);

  let url = browser.runtime.getURL('popup/popup.html');
  if (prefillCnpj) url += `?cnpj=${encodeURIComponent(prefillCnpj)}`;

  await browser.windows.create({ url, type: 'popup', width, height, left, top });
}

browser.action.onClicked.addListener(() => {
  openPopupWindow();
});

function addLog(cnpj, message, level = 'info') {
  const run = runs[cnpj];
  if (!run) return;
  run.log.push({ message, level, at: Date.now() });
  persistRuns();
  broadcast({ type: 'RUN_UPDATE', cnpj, run });
}

/* Mantém só as execuções em andamento + as N mais recentes já terminadas
   — sem isso, storage.local.runs cresceria sem limite ao longo do tempo
   (cada CNPJ emitido vira uma entrada nova, e nada removia as antigas). */
function pruneRuns() {
  const entries = Object.entries(runs);
  const running = entries.filter(([, r]) => r.status === 'running');
  const terminal = entries.filter(([, r]) => r.status !== 'running').sort((a, b) => b[1].startedAt - a[1].startedAt);
  runs = Object.fromEntries([...running, ...terminal.slice(0, MAX_STORED_TERMINAL_RUNS)]);
}

function persistRuns() {
  pruneRuns();
  browser.storage.local.set({ runs }).catch(() => {});
}

function broadcast(msg) {
  browser.runtime.sendMessage(msg).catch(() => {});
}

async function updateBadge() {
  const runningCount = Object.values(runs).filter((r) => r.status === 'running').length;
  await browser.action.setBadgeText({ text: runningCount > 0 ? String(runningCount) : '' });
  if (runningCount > 0) await browser.action.setBadgeBackgroundColor({ color: '#1f6f4a' });
}

/* Procura em TODAS as execuções (não só uma) qual job pertence a essa aba
   — precisa varrer o mapa inteiro agora que existe mais de uma execução
   simultânea possível. */
function findJobByTabId(tabId) {
  if (tabId == null) return null;
  for (const [cnpj, run] of Object.entries(runs)) {
    for (const [siteKey, job] of Object.entries(run.jobs)) {
      if (job.tabId === tabId) return { cnpj, siteKey, job, run };
    }
  }
  return null;
}

async function startRun(rawCnpj, selectedSites) {
  const cnpj = CNPJUtil.onlyDigits(rawCnpj);
  if (!CNPJUtil.isValid(cnpj)) {
    return { ok: false, error: 'CNPJ inválido.' };
  }
  /* Só bloqueia se for o MESMO CNPJ já em andamento — CNPJs diferentes
     rodam em paralelo, sem bloquear um ao outro. */
  if (runs[cnpj] && runs[cnpj].status === 'running') {
    return { ok: false, error: 'Já existe uma execução em andamento para este CNPJ.' };
  }

  const sites = (Array.isArray(selectedSites) && selectedSites.length ? selectedSites : DEFAULT_SELECTED_SITES).filter(
    (s) => SITES[s]
  );
  if (!sites.length) {
    return { ok: false, error: 'Selecione ao menos uma certidão.' };
  }

  runs[cnpj] = {
    cnpj,
    selectedSites: sites,
    jobs: Object.fromEntries(sites.map((siteKey) => [siteKey, { tabId: null, status: 'pending', retryCount: 0 }])),
    status: 'running',
    log: [],
    startedAt: Date.now(),
  };
  await browser.storage.local.set({ lastCnpj: cnpj, selectedCertidoes: sites });
  addLog(cnpj, `Iniciando emissão para CNPJ ${CNPJUtil.format(cnpj)} — ${sites.map((s) => SITES[s].label).join(', ')}.`);
  await updateBadge();

  /* Abre todas as abas em paralelo — nenhuma espera a outra terminar. */
  await Promise.all(sites.map((siteKey, i) => startJob(cnpj, siteKey, i === 0)));
  return { ok: true };
}

async function startJob(cnpj, siteKey, makeActive) {
  const site = SITES[siteKey];
  const job = runs[cnpj].jobs[siteKey];
  job.status = 'running';
  job.startedAt = Date.now();

  if (site.mode === 'manual') {
    addLog(cnpj, `${site.label}: essa certidão exige login — abrindo a aba para você concluir manualmente. Feche a aba quando terminar.`, 'warn');
    const tab = await browser.tabs.create({ url: site.url, active: makeActive });
    job.tabId = tab.id;
    persistRuns();
    return;
  }

  await checkAiSuggestion(siteKey);
  addLog(cnpj, `Abrindo ${site.label}...`);
  const tab = await browser.tabs.create({ url: site.url, active: makeActive });
  job.tabId = tab.id;
  persistRuns();
}

/* outcome opcional distingue, dentro de um sucesso, o caso em que o
   processo terminou mas não havia certidão nenhuma pra extrair (ex.:
   impedimento reportado pela Caixa) — usado só para colorir o popup
   diferente de um sucesso normal, não muda o resultado do run. */
function succeedJob(cnpj, siteKey, outcome) {
  const run = runs[cnpj];
  if (!run || !run.jobs[siteKey]) return;
  run.jobs[siteKey].status = 'success';
  run.jobs[siteKey].outcome = outcome || 'success';
  checkRunCompletion(cnpj);
}

function failJob(cnpj, siteKey, reasonMessage) {
  const run = runs[cnpj];
  if (!run || !run.jobs[siteKey]) return;
  run.jobs[siteKey].status = 'error';
  addLog(cnpj, `${SITES[siteKey].label}: ${reasonMessage}.`, 'error');
  checkRunCompletion(cnpj);
}

async function checkRunCompletion(cnpj) {
  const run = runs[cnpj];
  if (!run || run.status === 'cancelled') return;
  const jobs = Object.values(run.jobs);
  const allTerminal = jobs.every((j) => j.status === 'success' || j.status === 'error');
  if (!allTerminal) {
    persistRuns();
    return;
  }

  const failedSites = Object.entries(run.jobs)
    .filter(([, j]) => j.status === 'error')
    .map(([siteKey]) => SITES[siteKey].label);
  const cnpjFormatted = CNPJUtil.format(cnpj);

  if (failedSites.length) {
    run.status = 'error';
    addLog(cnpj, `Concluído com falha em: ${failedSites.join(', ')}. As demais certidões foram processadas normalmente.`, 'error');
    browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL(NOTIFICATION_ICON),
      title: 'CertFlow — concluído com falhas',
      message: `CNPJ ${cnpjFormatted} — falhou: ${failedSites.join(', ')}. Confira o log no popup.`,
    }).catch(() => {});
  } else {
    run.status = 'done';
    addLog(cnpj, 'Todas as certidões foram processadas.', 'success');
    browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL(NOTIFICATION_ICON),
      title: 'CertFlow',
      message: `CNPJ ${cnpjFormatted} — certidões emitidas com sucesso.`,
    }).catch(() => {});
  }
  await updateBadge();
  persistRuns();
}

const AI_FIELDS = ['cnpjInput', 'submitButton', 'emitButton', 'downloadTrigger'];

function deriveApiBase(apiUrl) {
  return apiUrl.replace(/\/api\/logs\/?$/, '');
}

/* Só preenche automaticamente campos que HOJE não têm seletor nenhum
   configurado — nunca troca silenciosamente um override que já existe
   (manual ou de uma sugestão anterior da IA), mesmo que a IA tenha um
   palpite novo para ele. Isso evita que a extensão "regrida" sozinha algo
   que já estava funcionando. Não é vinculado a um CNPJ específico (as
   sugestões de seletor são por site, compartilhadas entre execuções), por
   isso não usa addLog aqui — não há um cnpj único pra associar. */
async function applyAiSuggestion(siteKey, record) {
  const { aiSuggestions = {} } = await browser.storage.local.get('aiSuggestions');
  aiSuggestions[siteKey] = record;
  await browser.storage.local.set({ aiSuggestions });

  const { aiAutoApply } = await browser.storage.local.get('aiAutoApply');
  if (!aiAutoApply) return;

  const {
    selectorOverrides = {},
    aiAppliedOverrides = {},
    extraStepOverrides = {},
  } = await browser.storage.local.get(['selectorOverrides', 'aiAppliedOverrides', 'extraStepOverrides']);
  selectorOverrides[siteKey] = selectorOverrides[siteKey] || {};
  aiAppliedOverrides[siteKey] = aiAppliedOverrides[siteKey] || {};
  extraStepOverrides[siteKey] = extraStepOverrides[siteKey] || {};

  let changed = false;
  for (const field of AI_FIELDS) {
    const suggested = record[field];
    if (!suggested || selectorOverrides[siteKey][field]) continue;
    selectorOverrides[siteKey][field] = suggested;
    aiAppliedOverrides[siteKey][field] = true;
    changed = true;
  }

  /* Passos extras vêm do modo de aprendizado (task mining) — coisas que a
     extensão não tinha um campo fixo para representar, tipo um seletor de
     UF ou uma caixa de "aceito os termos". Mesma regra: só entra sozinho
     se aquele "role" ainda não tiver nenhum passo configurado. */
  for (const step of record.extraSteps || []) {
    if (!step || !step.role || extraStepOverrides[siteKey][step.role]) continue;
    extraStepOverrides[siteKey][step.role] = { selector: step.selector, action: step.action, value: step.value };
    aiAppliedOverrides[siteKey][step.role] = true;
    changed = true;
  }

  if (changed) await browser.storage.local.set({ selectorOverrides, aiAppliedOverrides, extraStepOverrides });
}

/* Autenticação com a certflow-api: nunca existe um segredo estático fixo
   no código ou nas configurações da extensão — o usuário loga (usuário +
   senha, só nesse momento a senha trafega) e recebe um PAR de tokens:
   - accessToken: JWT de curta duração (20min), guardado em
     storage.session (existe só enquanto o navegador está aberto — nunca
     escrito em disco de forma persistente pela própria API de storage).
   - refreshToken: opaco, validade de dias, guardado em storage.local
     (precisa sobreviver a reiniciar o navegador). É revogável no
     servidor e rotacionado a cada uso (ver refreshTokenStore na API) —
     bem diferente de uma chave estática que, se vazasse, valeria pra
     sempre.
   Todo o resto do código (sugestão de seletores, captcha por IA, envio
   de log) passa a chamar callCertflowApi(), que cuida de anexar o
   accessToken válido (renovando via refreshToken quando necessário) —
   nenhuma outra função precisa saber como a autenticação funciona. */
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 30 * 1000;

async function getStoredTokens() {
  const [sessionData, localData] = await Promise.all([
    browser.storage.session.get(['accessToken', 'accessTokenExpiresAt']),
    browser.storage.local.get(['refreshToken', 'refreshTokenExpiresAt', 'apiUsername']),
  ]);
  return { ...sessionData, ...localData };
}

async function storeTokensFromAuthResponse(username, body) {
  const now = Date.now();
  await Promise.all([
    browser.storage.session.set({
      accessToken: body.accessToken,
      accessTokenExpiresAt: now + body.accessTokenExpiresIn * 1000,
    }),
    browser.storage.local.set({
      refreshToken: body.refreshToken,
      refreshTokenExpiresAt: now + body.refreshTokenExpiresIn * 1000,
      apiUsername: username,
    }),
  ]);
}

async function clearStoredTokens() {
  await Promise.all([
    browser.storage.session.remove(['accessToken', 'accessTokenExpiresAt']),
    browser.storage.local.remove(['refreshToken', 'refreshTokenExpiresAt', 'apiUsername']),
  ]);
}

async function apiLogin(username, password) {
  const { apiUrl } = await browser.storage.local.get('apiUrl');
  if (!apiUrl) return { ok: false, error: 'Configure a URL da API primeiro.' };
  try {
    const response = await fetch(`${deriveApiBase(apiUrl)}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await response.json();
    if (!response.ok) return { ok: false, error: body.error || `HTTP ${response.status}` };
    await storeTokensFromAuthResponse(username, body);
    return { ok: true, username };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

async function apiLogout() {
  const { refreshToken } = await getStoredTokens();
  await clearStoredTokens();
  if (!refreshToken) return { ok: true };
  const { apiUrl } = await browser.storage.local.get('apiUrl');
  if (!apiUrl) return { ok: true };
  try {
    await fetch(`${deriveApiBase(apiUrl)}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
  } catch (err) {
    /* Sessão local já foi limpa acima — revogar no servidor é best-effort,
       nunca deve impedir o "logout" do ponto de vista do usuário. */
  }
  return { ok: true };
}

/* Troca o refresh token por um par novo (rotação: o refresh token antigo
   já sai revogado no servidor). Se o refresh também falhar (expirado,
   revogado, ou já foi usado por outra aba/instância), limpa tudo — a
   sessão acabou, o usuário precisa logar de novo pela tela de
   Configurações. */
async function refreshAccessToken() {
  const { refreshToken } = await getStoredTokens();
  if (!refreshToken) return null;
  const { apiUrl, apiUsername } = await browser.storage.local.get(['apiUrl', 'apiUsername']);
  if (!apiUrl) return null;
  try {
    const response = await fetch(`${deriveApiBase(apiUrl)}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) {
      await clearStoredTokens();
      return null;
    }
    const body = await response.json();
    await storeTokensFromAuthResponse(apiUsername, body);
    return body.accessToken;
  } catch (err) {
    return null;
  }
}

/* Garante um accessToken utilizável: se o guardado ainda não expirou (com
   uma margem de segurança), reaproveita; senão tenta renovar via refresh
   token. Retorna null se não há sessão (usuário nunca logou ou a sessão
   expirou de vez) — quem chama trata isso como "não autenticado", nunca
   como erro de rede. */
async function ensureAccessToken() {
  const { accessToken, accessTokenExpiresAt } = await getStoredTokens();
  if (accessToken && accessTokenExpiresAt && accessTokenExpiresAt - ACCESS_TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return accessToken;
  }
  return refreshAccessToken();
}

/* Único lugar que fala HTTP com a certflow-api pra tudo que exige login —
   sugestão de seletores, captcha por IA, envio de log. Cuida de anexar o
   accessToken (renovando sozinho quando necessário) e, se mesmo assim a
   API responder 401 (token invalidado entre a checagem e a chamada, ou
   relógio dessincronizado), tenta renovar e repetir UMA vez antes de
   desistir. */
async function callCertflowApi(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const { apiUrl } = await browser.storage.local.get('apiUrl');
  if (!apiUrl) return { ok: false, error: 'Configure a URL da API primeiro (Configurações).', code: 'not_configured' };

  async function attempt(accessToken) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${deriveApiBase(apiUrl)}${path}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          Authorization: `Bearer ${accessToken}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  let accessToken = await ensureAccessToken();
  if (!accessToken) return { ok: false, error: 'Não autenticado — faça login em Configurações.', code: 'not_authenticated' };

  try {
    let response = await attempt(accessToken);
    if (response.status === 401) {
      accessToken = await refreshAccessToken();
      if (!accessToken) return { ok: false, error: 'Sessão expirada — faça login novamente.', code: 'not_authenticated' };
      response = await attempt(accessToken);
    }
    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: responseBody.error || `HTTP ${response.status}` };
    return { ok: true, ...responseBody };
  } catch (err) {
    const message = err && err.name === 'AbortError' ? 'Tempo esgotado consultando a API.' : String(err && err.message ? err.message : err);
    return { ok: false, error: message };
  }
}

/* Busca a última sugestão já calculada pela API (rápido, sem chamar a IA de
   novo) — chamado antes de abrir cada site num run normal. */
async function checkAiSuggestion(siteKey) {
  const result = await callCertflowApi(`/api/suggestions/${siteKey}`);
  if (result.ok) await applyAiSuggestion(siteKey, result);
}

/* Pede uma análise nova (chama a IA agora) — usado pelo botão manual nas
   Configurações, não roda automaticamente a cada execução. */
async function requestFreshAnalysis(siteKey) {
  const result = await callCertflowApi('/api/analyze', { method: 'POST', body: { siteKey } });
  if (result.ok) await applyAiSuggestion(siteKey, result);
  return result.ok ? { ok: true, record: result } : result;
}

/* Pede à certflow-api pra ler o texto de uma imagem de captcha via Gemini
   (nuvem) — fallback do Gemini Nano on-device, usado quando o Nano não
   está disponível (ex.: Firefox, ou Chrome sem o modelo baixado) ou não
   conseguiu ler. */
async function requestCaptchaSolve(siteKey, imageBase64, mime) {
  return callCertflowApi('/api/captcha/solve', { method: 'POST', body: { siteKey, imageBase64, mime } });
}

/* Só um registro pra revisão humana (nem o Gemini via API, nem o Nano
   on-device, têm algum mecanismo de "aprender" a partir de uma chamada
   individual — não existe ajuste fino em tempo real por request). Serve
   pra, mais adiante, olhar a taxa de acerto real e ajustar o prompt do
   captcha se necessário — mesmo espírito do log de diagnóstico que já
   alimenta as sugestões de seletor. Fogo-e-esquece: nunca deve atrasar
   nem falhar a execução por causa disso. */
async function sendCaptchaFeedback(siteKey, texto, success) {
  await callCertflowApi('/api/captcha/feedback', { method: 'POST', body: { siteKey, texto, success } });
}

/* Restaura runs a partir do storage se o service worker (Chrome MV3) foi
   encerrado por inatividade entre uma mensagem e outra — sem isso, uma
   execução em andamento "sumiria" silenciosamente no meio do fluxo. Só
   precisa rodar uma vez por "acordar" do service worker. */
async function hydrateRuns() {
  if (hydrated) return;
  hydrated = true;
  const { runs: stored } = await browser.storage.local.get('runs');
  if (stored) {
    for (const [cnpj, run] of Object.entries(stored)) {
      if (!runs[cnpj]) runs[cnpj] = run;
    }
  }
}

async function attemptSaveAsPdf(tabId, siteKey, cnpj) {
  if (!browser.tabs.saveAsPDF) {
    addLog(cnpj, 'Não foi possível localizar um link de download; salve manualmente com Ctrl+P na aba aberta.', 'warn');
    return;
  }
  addLog(cnpj, 'Nenhum link direto encontrado — abrindo diálogo "Salvar como PDF" do Firefox (uma confirmação manual).', 'warn');
  try {
    const result = await browser.tabs.saveAsPDF({});
    if (result === 'saved') {
      addLog(cnpj, `${SITES[siteKey].label}: PDF salvo pelo diálogo do Firefox.`, 'success');
    } else {
      addLog(cnpj, `${SITES[siteKey].label}: salvamento em PDF cancelado pelo usuário.`, 'warn');
    }
  } catch (err) {
    addLog(cnpj, `Falha ao chamar o diálogo de salvar PDF: ${err.message || err}`, 'error');
  }
}

/* <pasta configurada>/<data>_<hora>_<CNPJ>_<nome da certidão>.<ext> — sem
   subpastas por CNPJ/data, tudo dentro de uma pasta só (a "pasta
   configurada", padrão "CertFlow"); a raiz de tudo isso é sempre a pasta
   de downloads que o usuário configurou no navegador — a API de
   downloads não permite escolher um caminho fora dela. */
async function buildCertidaoFilename(siteKey, cnpj, ext) {
  const { downloadFolder } = await browser.storage.local.get('downloadFolder');
  const folder = downloadFolder || 'CertFlow';
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10);
  const timePart = now.toTimeString().slice(0, 8).replace(/:/g, '-');
  return `${folder}/${datePart}_${timePart}_${cnpj}_${SITES[siteKey].fileTag}.${ext}`;
}

async function handleDownloadBlob(msg) {
  const { siteKey, cnpj, dataBase64, mime } = msg;
  const ext = mime && mime.includes('pdf') ? 'pdf' : 'html';
  const filename = await buildCertidaoFilename(siteKey, cnpj, ext);

  const byteChars = atob(dataBase64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime || 'application/pdf' });
  const url = URL.createObjectURL(blob);

  try {
    const downloadId = await browser.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
    selfInitiatedDownloadIds.add(downloadId);
    const { history = [] } = await browser.storage.local.get('history');
    history.unshift({ cnpj, siteKey, filename, downloadId, at: Date.now() });
    await browser.storage.local.set({ history: history.slice(0, 100) });
    addLog(cnpj, `${SITES[siteKey].label}: arquivo salvo em "${filename}".`, 'success');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

/* Alguns sites (ex.: "Segunda Via" da RFB) disparam um download nativo do
   próprio navegador — o servidor responde com Content-Disposition:
   attachment ou similar, sem nenhum link/blob visível no DOM pro content
   script capturar. Sem isso, a extensão não tinha como saber que o
   arquivo já foi salvo pelo próprio navegador, e caía no fallback de
   imprimir a TELA (gerando um PDF errado, além do PDF real já baixado). */
const selfInitiatedDownloadIds = new Set();

function siteHostname(siteKey) {
  try {
    return new URL(SITES[siteKey].url).hostname;
  } catch (err) {
    return null;
  }
}

async function hasNativeDownloadForSite(siteKey, sinceMs) {
  try {
    const hostname = siteHostname(siteKey);
    if (!hostname) return false;
    const results = await browser.downloads.search({ startedAfter: new Date(sinceMs).toISOString() });
    return results.some((d) => {
      if (selfInitiatedDownloadIds.has(d.id)) return false;
      const ref = `${d.referrer || ''} ${d.url || ''}`;
      return ref.includes(hostname);
    });
  } catch (err) {
    return false;
  }
}

/* Uma checagem só, na hora, pode rodar cedo demais: se o site demorar pra
   gerar o PDF (confirmado por um usuário: aconteceu bem depois do clique),
   o download nativo ainda nem começou quando checamos, e a extensão cai no
   fallback errado (imprimir a tela) momentos antes do download real
   começar. Insiste por alguns segundos antes de desistir — mas não tempo
   demais: quando REALMENTE não vai ter download nativo nenhum (precisa
   mesmo do diálogo manual), esses segundos só atrasam à toa (reportado
   por um usuário como "um pouco demorado"). 5s é um meio-termo. */
async function waitForNativeDownload(siteKey, sinceMs, { timeout = 5000, interval = 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await hasNativeDownloadForSite(siteKey, sinceMs)) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

/* Acha, entre TODAS as execuções em andamento, uma cujo site bata com o
   hostname do download nativo — usado por onDeterminingFilename abaixo,
   que não tem um jeito direto de saber a qual execução um download
   pertence (a API não expõe tabId do download). */
function findRunningJobBySiteHostname(referrerAndUrl) {
  for (const [cnpj, run] of Object.entries(runs)) {
    if (run.status !== 'running') continue;
    for (const siteKey of Object.keys(run.jobs)) {
      if (run.jobs[siteKey].status !== 'running') continue;
      const hostname = siteHostname(siteKey);
      if (hostname && referrerAndUrl.includes(hostname)) return { cnpj, siteKey };
    }
  }
  return null;
}

/* A pasta configurada em Configurações (downloadFolder) só era aplicada
   pra downloads que a PRÓPRIA extensão iniciava (handleDownloadBlob) —
   downloads nativos disparados pelo site (ex.: "Segunda Via", "Emitir
   Nova Certidão" quando o servidor responde com Content-Disposition:
   attachment) iam pro nome/local padrão do navegador, ignorando a
   configuração por completo (reportado por um usuário). onDeterminingFilename
   intercepta QUALQUER download (nativo ou não) antes de ele ser salvo,
   permitindo sugerir um nome/caminho novo — usado aqui pra redirecionar
   também os downloads nativos pra mesma pasta/convenção de nome.

   Registro protegido por try/catch: se downloads.onDeterminingFilename
   não existir ou não puder ser usado nesse navegador/versão, um erro
   síncrono aqui pararia a execução do resto do arquivo — inclusive
   registros mais abaixo, como o clique no menu de contexto que abre o
   popup (bug real: o popup parou de abrir pelo menu de contexto depois
   dessa função ser adicionada, porque ela vem antes no arquivo). Nunca
   deixa uma função nova e opcional derrubar o resto da extensão. */
try {
  browser.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    /* Nunca reprocessa os que a própria extensão já iniciou (já vieram com
       o nome certo de handleDownloadBlob) — checa tanto pelo id quanto pelo
       esquema da URL blob:, que só a extensão usa (belt-and-suspenders,
       dado que o id pode não estar no Set ainda por uma corrida de timing). */
    const isOwnBlob = /^blob:(moz|chrome)-extension:\/\//.test(downloadItem.url || '');
    if (selfInitiatedDownloadIds.has(downloadItem.id) || isOwnBlob) return false;

    const ref = `${downloadItem.referrer || ''} ${downloadItem.url || ''}`;
    const match = findRunningJobBySiteHostname(ref);
    if (!match) return false;
    const { cnpj, siteKey } = match;

    (async () => {
      const originalName = downloadItem.filename || 'certidao.pdf';
      const extMatch = /\.([a-zA-Z0-9]+)$/.exec(originalName);
      const ext = extMatch ? extMatch[1] : 'pdf';
      const filename = await buildCertidaoFilename(siteKey, cnpj, ext);
      try {
        suggest({ filename, conflictAction: 'uniquify' });
        const { history = [] } = await browser.storage.local.get('history');
        history.unshift({ cnpj, siteKey, filename, downloadId: downloadItem.id, at: Date.now() });
        await browser.storage.local.set({ history: history.slice(0, 100) });
      } catch (err) {
        /* Se o navegador já rejeitou por algum motivo, deixa seguir com o
           nome padrão em vez de travar o download inteiro. */
      }
    })();
    return true; // sinaliza que suggest() será chamado de forma assíncrona
  });
} catch (err) {
  console.error('CertFlow: não foi possível registrar downloads.onDeterminingFilename', err);
}

async function sendLogToApi(events, source) {
  const { apiAutoSend } = await browser.storage.local.get('apiAutoSend');
  if (!apiAutoSend) return;

  const result = await callCertflowApi('/api/logs', { method: 'POST', body: { source: source || 'certflow-extension', events } });
  await browser.storage.local.set({
    apiStatus: result.ok
      ? { ok: true, at: Date.now(), message: 'Envio ok.' }
      : { ok: false, at: Date.now(), message: result.error },
  });
}

async function handleCsStatus(msg, sender) {
  const found = findJobByTabId(sender.tab?.id);
  if (!found || found.siteKey !== msg.siteKey) return;
  const { cnpj, job, run } = found;
  const site = SITES[msg.siteKey];

  switch (msg.status) {
    case 'submitting':
      addLog(cnpj, `${site.label}: consulta enviada.`);
      break;
    case 'captcha':
      addLog(cnpj, `${site.label}: captcha detectado — resolva-o na aba aberta para continuar.`, 'warn');
      browser.notifications.create({
        type: 'basic',
        iconUrl: browser.runtime.getURL(NOTIFICATION_ICON),
        title: 'CertFlow — ação necessária',
        message: `CNPJ ${CNPJUtil.format(cnpj)} — resolva o captcha na aba "${site.label}" para continuar.`,
      }).catch(() => {});
      break;
    case 'result_ready':
      addLog(cnpj, `${site.label}: resultado obtido${msg.detail ? ' — ' + msg.detail : ''}.`, msg.detail?.includes('Positiva') ? 'warn' : 'info');
      break;
    case 'ai_verdict': {
      const v = msg.detail || {};
      const AI_STATUS_LABEL = {
        regular: 'Regular',
        positiva_com_pendencia: 'Com pendências',
        erro: 'Erro',
        desconhecido: 'Indeterminado',
      };
      const label = AI_STATUS_LABEL[v.status] || v.status || 'Indeterminado';
      const level = v.status === 'regular' ? 'success' : v.status === 'positiva_com_pendencia' ? 'warn' : 'ai';
      addLog(cnpj, `${site.label}: IA (Gemini Nano) — ${label}${v.resumo ? ': ' + v.resumo : ''}`, level);
      run.aiVerdicts = run.aiVerdicts || {};
      run.aiVerdicts[msg.siteKey] = v;
      persistRuns();
      break;
    }
    case 'emitting':
      addLog(cnpj, `${site.label}: emitindo certidão...`);
      break;
    case 'temporarily_unavailable': {
      job.retryCount = (job.retryCount || 0) + 1;
      if (job.retryCount > UNAVAILABLE_MAX_RETRIES) {
        failJob(cnpj, msg.siteKey, `${msg.detail || 'serviço indisponível'} — desistindo após ${UNAVAILABLE_MAX_RETRIES} tentativas`);
        break;
      }
      addLog(
        cnpj,
        `${site.label}: ${msg.detail || 'serviço indisponível'} — nova tentativa (${job.retryCount}/${UNAVAILABLE_MAX_RETRIES}) em ${Math.round(UNAVAILABLE_RETRY_DELAY_MS / 1000)}s.`,
        'warn'
      );
      persistRuns();
      await browser.alarms.create(`certflow-retry-${cnpj}-${msg.siteKey}`, { when: Date.now() + UNAVAILABLE_RETRY_DELAY_MS });
      break;
    }
    case 'emailed':
      addLog(cnpj, `${site.label}: certidão emitida e enviada por e-mail${msg.detail ? ' — ' + msg.detail : ''}. Confira a caixa de entrada (e o spam).`, 'success');
      succeedJob(cnpj, msg.siteKey);
      break;
    case 'downloaded':
      succeedJob(cnpj, msg.siteKey);
      break;
    case 'manual_save_needed': {
      /* Antes de cair no fallback de imprimir a TELA, confere se o próprio
         site já disparou (ou está prestes a disparar) um download nativo
         do navegador (comum quando o servidor responde com
         Content-Disposition: attachment — não deixa rastro nenhum no DOM
         pro content script ver). Insiste por alguns segundos: se o site
         demorar pra gerar o PDF, uma checagem única rodaria cedo demais e
         cairia no fallback errado momentos antes do download real
         começar (confirmado por um usuário). Se já baixou (ou baixa
         dentro da espera), o arquivo real já está salvo; não faz sentido
         salvar a tela também. */
      const nativeDownload = await waitForNativeDownload(msg.siteKey, job.startedAt || run.startedAt);
      if (nativeDownload) {
        addLog(cnpj, `${site.label}: o próprio site já iniciou o download do PDF — não é preciso salvar a tela.`, 'success');
      } else {
        await attemptSaveAsPdf(job.tabId, msg.siteKey, cnpj);
      }
      succeedJob(cnpj, msg.siteKey);
      break;
    }
    case 'concluded_without_certificate':
      addLog(cnpj, `${site.label}: processo concluído, mas não há certidão para extrair${msg.detail ? ' — ' + msg.detail : ''}. Salvando a tela.`, 'warn');
      await attemptSaveAsPdf(job.tabId, msg.siteKey, cnpj);
      succeedJob(cnpj, msg.siteKey, 'no_certificate');
      break;
    case 'error':
      failJob(cnpj, msg.siteKey, msg.detail || 'erro desconhecido');
      break;
    case 'restart_for_emit_new':
      /* A certidão existente não atendia à validade mínima configurada —
         precisa voltar pra URL inicial e refazer o fluxo indo direto para
         "Emitir Nova Certidão" (o flag sobrevive à navegação porque
         runs[cnpj].jobs vive no background, não na aba).

         Só trocar a URL não bastava: a app é uma SPA com rota via hash
         (#/home/cnpj/...), e tabs.update para uma URL que só difere no
         hash não força uma navegação de verdade — o Angular pode até
         redirecionar de volta pro mesmo estado profundo em vez de
         recarregar do zero (confirmado num log real: a aba ficou presa
         na rota antiga, "#/home/cnpj/consultar/resultado", mesmo depois
         da troca de URL). Navega primeiro para about:blank — um
         documento de verdade diferente, que força o descarte completo da
         página atual — e só depois para a URL real, garantindo duas
         navegações genuínas em vez de uma troca de hash que a SPA possa
         ignorar ou reverter. */
      job.forceEmitNew = true;
      addLog(cnpj, `${site.label}: certidão existente não atende à validade mínima configurada — emitindo uma nova.`, 'warn');
      await browser.tabs.update(job.tabId, { url: 'about:blank' }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 300));
      await browser.tabs.update(job.tabId, { url: site.url }).catch(() => {});
      break;
    default:
      break;
  }
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await hydrateRuns();
    switch (msg.type) {
      case 'START_RUN': {
        const result = await startRun(msg.cnpj, msg.selectedSites);
        sendResponse(result);
        break;
      }
      case 'GET_RUN_STATE': {
        const { history = [], lastCnpj = '', selectedCertidoes } = await browser.storage.local.get([
          'history',
          'lastCnpj',
          'selectedCertidoes',
        ]);
        const cnpj = msg.cnpj ? CNPJUtil.onlyDigits(msg.cnpj) : null;
        sendResponse({
          run: cnpj ? runs[cnpj] || null : null,
          history,
          lastCnpj,
          availableSites: Object.fromEntries(Object.entries(SITES).map(([k, v]) => [k, { label: v.label, mode: v.mode }])),
          selectedCertidoes: selectedCertidoes && selectedCertidoes.length ? selectedCertidoes : DEFAULT_SELECTED_SITES,
        });
        break;
      }
      case 'CANCEL_RUN': {
        const cnpj = msg.cnpj ? CNPJUtil.onlyDigits(msg.cnpj) : null;
        const run = cnpj ? runs[cnpj] : null;
        if (run && run.status === 'running') {
          run.status = 'cancelled';
          addLog(cnpj, 'Execução cancelada pelo usuário.', 'warn');
          await updateBadge();
        }
        sendResponse({ ok: true });
        break;
      }
      case 'CS_READY': {
        const found = findJobByTabId(sender.tab?.id);
        if (found && found.siteKey === msg.siteKey && found.job.status === 'running' && found.run.status === 'running') {
          browser.tabs
            .sendMessage(sender.tab.id, { type: 'RUN_JOB', siteKey: msg.siteKey, cnpj: found.cnpj, forceEmitNew: !!found.job.forceEmitNew })
            .catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }
      case 'CS_STATUS': {
        await handleCsStatus(msg, sender);
        sendResponse({ ok: true });
        break;
      }
      case 'DOWNLOAD_BLOB': {
        await handleDownloadBlob(msg);
        sendResponse({ ok: true });
        break;
      }
      case 'START_PICKER': {
        let targetTabId = msg.tabId;
        if (!targetTabId) {
          const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
          targetTabId = activeTab && activeTab.id;
        }
        if (targetTabId) {
          browser.tabs.sendMessage(targetTabId, msg).catch(() => {});
          await browser.tabs.update(targetTabId, { active: true }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }
      case 'PICKER_RESULT': {
        if (msg.selector) {
          const { selectorOverrides = {}, aiAppliedOverrides = {} } = await browser.storage.local.get(['selectorOverrides', 'aiAppliedOverrides']);
          selectorOverrides[msg.siteKey] = selectorOverrides[msg.siteKey] || {};
          selectorOverrides[msg.siteKey][msg.kind] = msg.selector;
          if (aiAppliedOverrides[msg.siteKey]) delete aiAppliedOverrides[msg.siteKey][msg.kind];
          await browser.storage.local.set({ selectorOverrides, aiAppliedOverrides });
        }
        sendResponse({ ok: true });
        break;
      }
      case 'REQUEST_AI_ANALYSIS': {
        const result = await requestFreshAnalysis(msg.siteKey);
        sendResponse(result);
        break;
      }
      case 'API_LOGIN': {
        const result = await apiLogin(msg.username, msg.password);
        sendResponse(result);
        break;
      }
      case 'API_LOGOUT': {
        const result = await apiLogout();
        sendResponse(result);
        break;
      }
      case 'GET_API_AUTH_STATUS': {
        const { refreshToken, refreshTokenExpiresAt, apiUsername } = await getStoredTokens();
        sendResponse({
          authenticated: !!refreshToken && refreshTokenExpiresAt > Date.now(),
          username: apiUsername || null,
        });
        break;
      }
      case 'SEND_LOG_NOW': {
        const result = await callCertflowApi('/api/logs', {
          method: 'POST',
          body: { source: 'certflow-extension-manual', events: msg.events },
        });
        sendResponse(result);
        break;
      }
      case 'SOLVE_CAPTCHA': {
        const result = await requestCaptchaSolve(msg.siteKey, msg.imageBase64, msg.mime);
        sendResponse(result);
        break;
      }
      case 'CAPTCHA_FEEDBACK': {
        sendCaptchaFeedback(msg.siteKey, msg.texto, msg.success).catch(() => {});
        sendResponse({ ok: true });
        break;
      }
      case 'DEBUG_LOG': {
        const entry = { at: msg.at, siteKey: msg.siteKey, step: msg.step, detail: msg.detail, snapshot: msg.snapshot };
        await appendDebugLogEntry(entry);
        sendLogToApi([entry], 'certflow-extension-auto').catch(() => {});
        sendResponse({ ok: true });
        break;
      }
      default:
        break;
    }
  })();
  return true;
});

browser.contextMenus.onClicked?.addListener(async (info) => {
  if (info.menuItemId !== 'certflow-run-selection') return;
  const digits = CNPJUtil.onlyDigits(info.selectionText || '');
  if (!CNPJUtil.isValid(digits)) {
    browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL(NOTIFICATION_ICON),
      title: 'CertFlow',
      message: 'O texto selecionado não é um CNPJ válido.',
    }).catch(() => {});
    return;
  }
  /* Não dispara startRun() direto — abre um popup NOVO (com o CNPJ já
     preenchido) pra o usuário confirmar/escolher quais certidões emitir
     antes de qualquer aba ser aberta, do mesmo jeito que clicar no ícone.
     Cada seleção abre sua própria janela independente. */
  await openPopupWindow(digits);
});

browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus.create({
    id: 'certflow-run-selection',
    title: 'CertFlow: emitir certidões para "%s"',
    contexts: ['selection'],
  });
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  const prefix = 'certflow-retry-';
  if (!alarm.name.startsWith(prefix)) return;
  await hydrateRuns();
  /* CNPJ é sempre 14 dígitos fixos — dá pra separar do siteKey de forma
     confiável sem ambiguidade (certflow-retry-<14 dígitos>-<siteKey>). */
  const rest = alarm.name.slice(prefix.length);
  const cnpj = rest.slice(0, 14);
  const siteKey = rest.slice(15);
  const run = runs[cnpj];
  const job = run?.jobs[siteKey];
  if (!run || run.status !== 'running' || !job || job.status !== 'running') return;
  addLog(cnpj, `${SITES[siteKey].label}: tentando novamente...`);
  await browser.tabs.reload(job.tabId).catch(() => {});
});

/* Sem isso, fechar a aba de uma certidão manual (Simples Nacional) nunca
   seria percebido como "terminei"; e fechar a aba de uma certidão
   automática no meio do processo deixaria aquele job preso em "running"
   pra sempre, travando a conclusão do run. */
browser.tabs.onRemoved.addListener((tabId) => {
  const found = findJobByTabId(tabId);
  if (!found || found.job.status !== 'running' || found.run.status !== 'running') return;
  const { cnpj, siteKey, job } = found;

  if (SITES[siteKey].mode === 'manual') {
    job.status = 'success';
    addLog(cnpj, `${SITES[siteKey].label}: aba fechada — considerando concluído (confira se a certidão foi realmente emitida).`, 'success');
  } else {
    job.status = 'error';
    addLog(cnpj, `${SITES[siteKey].label}: aba foi fechada antes de terminar.`, 'error');
  }
  checkRunCompletion(cnpj);
});
