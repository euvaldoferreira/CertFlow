/* Orquestra a execução: abre cada site em sequência, manda o content script
   preencher o CNPJ, aguarda captcha/resultado e salva o PDF gerado.
   No Firefox, CNPJUtil vem de lib/cnpj.js carregado antes deste arquivo pelo
   manifest ("background.scripts"). No Chrome, este arquivo roda sozinho
   como service worker (MV3 só aceita um "service_worker"), então ele mesmo
   importa lib/cnpj.js — só faz sentido nesse contexto, por isso o guard. */
const IS_SERVICE_WORKER = typeof importScripts === 'function';
if (IS_SERVICE_WORKER) {
  importScripts('lib/browser-shim.js', 'lib/cnpj.js');
}

const NOTIFICATION_ICON = IS_SERVICE_WORKER ? 'icons/chrome/icon-128.png' : 'icons/icon.svg';
const UNAVAILABLE_RETRY_DELAY_MS = 90 * 1000;
const UNAVAILABLE_MAX_RETRIES = 3;

const SITES = {
  rfb: {
    label: 'Receita Federal - Certidão de Regularidade Fiscal',
    fileTag: 'RFB-certidao-regularidade-fiscal',
    url: 'https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj',
  },
  caixa: {
    label: 'Caixa - Certificado de Regularidade do FGTS',
    fileTag: 'Caixa-CRF-FGTS',
    url: 'https://consulta-crf.caixa.gov.br/consultacrf/pages/consultaEmpregador.jsf',
  },
};
const RUN_ORDER = ['rfb', 'caixa'];

let currentRun = null;

function addLog(message, level = 'info') {
  if (!currentRun) return;
  currentRun.log.push({ message, level, at: Date.now() });
  persistRun();
  broadcast({ type: 'RUN_UPDATE', run: currentRun });
}

function persistRun() {
  browser.storage.local.set({ currentRun }).catch(() => {});
}

function broadcast(msg) {
  browser.runtime.sendMessage(msg).catch(() => {});
}

async function setBadge(text, color) {
  await browser.action.setBadgeText({ text: text || '' });
  if (color) await browser.action.setBadgeBackgroundColor({ color });
}

async function startRun(rawCnpj) {
  const cnpj = CNPJUtil.onlyDigits(rawCnpj);
  if (!CNPJUtil.isValid(cnpj)) {
    return { ok: false, error: 'CNPJ inválido.' };
  }
  if (currentRun && currentRun.status === 'running') {
    return { ok: false, error: 'Já existe uma execução em andamento.' };
  }

  currentRun = {
    runId: crypto.randomUUID(),
    cnpj,
    order: RUN_ORDER.slice(),
    index: 0,
    tabId: null,
    status: 'running',
    log: [],
    retryCount: 0,
    siteResults: {},
    startedAt: Date.now(),
  };
  await browser.storage.local.set({ lastCnpj: cnpj });
  addLog(`Iniciando emissão para CNPJ ${CNPJUtil.format(cnpj)}.`);
  await setBadge('...', '#1f6f4a');
  await advanceToNextJob();
  return { ok: true };
}

async function advanceToNextJob() {
  if (!currentRun || currentRun.status !== 'running') return;

  if (currentRun.index >= currentRun.order.length) {
    const failedSites = Object.entries(currentRun.siteResults || {})
      .filter(([, result]) => result === 'error')
      .map(([siteKey]) => SITES[siteKey].label);

    if (failedSites.length) {
      currentRun.status = 'error';
      addLog(`Concluído com falha em: ${failedSites.join(', ')}. As demais certidões foram salvas normalmente.`, 'error');
      await setBadge('!', '#c0392b');
      browser.notifications.create({
        type: 'basic',
        iconUrl: browser.runtime.getURL(NOTIFICATION_ICON),
        title: 'CertFlow — concluído com falhas',
        message: `Falhou: ${failedSites.join(', ')}. Confira o log no popup.`,
      }).catch(() => {});
    } else {
      currentRun.status = 'done';
      addLog('Todas as certidões foram processadas.', 'success');
      await setBadge('OK', '#2f9e5c');
      browser.notifications.create({
        type: 'basic',
        iconUrl: browser.runtime.getURL(NOTIFICATION_ICON),
        title: 'CertFlow',
        message: 'Certidões emitidas e salvas com sucesso.',
      }).catch(() => {});
    }
    return;
  }

  const siteKey = currentRun.order[currentRun.index];
  const site = SITES[siteKey];
  currentRun.retryCount = 0;
  await checkAiSuggestion(siteKey);
  addLog(`Abrindo ${site.label}...`);
  const tab = await browser.tabs.create({ url: site.url, active: true });
  currentRun.tabId = tab.id;
  currentRun.currentSite = siteKey;
  persistRun();
}

const AI_FIELDS = ['cnpjInput', 'submitButton', 'emitButton', 'downloadTrigger'];

function deriveApiBase(apiUrl) {
  return apiUrl.replace(/\/api\/logs\/?$/, '');
}

/* Só preenche automaticamente campos que HOJE não têm seletor nenhum
   configurado — nunca troca silenciosamente um override que já existe
   (manual ou de uma sugestão anterior da IA), mesmo que a IA tenha um
   palpite novo para ele. Isso evita que a extensão "regrida" sozinha algo
   que já estava funcionando. */
async function applyAiSuggestion(siteKey, record) {
  const { aiSuggestions = {} } = await browser.storage.local.get('aiSuggestions');
  aiSuggestions[siteKey] = record;
  await browser.storage.local.set({ aiSuggestions });

  const { aiAutoApply } = await browser.storage.local.get('aiAutoApply');
  if (!aiAutoApply) return;

  const { selectorOverrides = {}, aiAppliedOverrides = {} } = await browser.storage.local.get(['selectorOverrides', 'aiAppliedOverrides']);
  selectorOverrides[siteKey] = selectorOverrides[siteKey] || {};
  aiAppliedOverrides[siteKey] = aiAppliedOverrides[siteKey] || {};

  let changed = false;
  for (const field of AI_FIELDS) {
    const suggested = record[field];
    if (!suggested || selectorOverrides[siteKey][field]) continue;
    selectorOverrides[siteKey][field] = suggested;
    aiAppliedOverrides[siteKey][field] = true;
    changed = true;
    addLog(`${SITES[siteKey].label}: IA aplicou automaticamente um seletor para "${field}" (estava sem configuração).`, 'ai');
  }
  if (changed) await browser.storage.local.set({ selectorOverrides, aiAppliedOverrides });
}

/* Busca a última sugestão já calculada pela API (rápido, sem chamar a IA de
   novo) — chamado antes de abrir cada site num run normal. */
async function checkAiSuggestion(siteKey) {
  const { apiUrl, apiKey } = await browser.storage.local.get(['apiUrl', 'apiKey']);
  if (!apiUrl || !apiKey) return;
  try {
    const response = await fetch(`${deriveApiBase(apiUrl)}/api/suggestions/${siteKey}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) return;
    await applyAiSuggestion(siteKey, await response.json());
  } catch (err) {
    /* silencioso: nunca deve travar o fluxo de emissão por causa disso */
  }
}

/* Pede uma análise nova (chama a IA agora) — usado pelo botão manual nas
   Configurações, não roda automaticamente a cada execução. */
async function requestFreshAnalysis(siteKey) {
  const { apiUrl, apiKey } = await browser.storage.local.get(['apiUrl', 'apiKey']);
  if (!apiUrl || !apiKey) return { ok: false, error: 'Configure a URL e a chave da API primeiro.' };
  try {
    const response = await fetch(`${deriveApiBase(apiUrl)}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ siteKey }),
    });
    const body = await response.json();
    if (!response.ok) return { ok: false, error: body.error || `HTTP ${response.status}` };
    await applyAiSuggestion(siteKey, body);
    return { ok: true, record: body };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/* Restaura currentRun a partir do storage se o service worker (Chrome MV3)
   foi encerrado por inatividade entre uma mensagem e outra — sem isso, uma
   execução em andamento "sumiria" silenciosamente no meio do fluxo. */
async function hydrateRun() {
  if (currentRun) return;
  const { currentRun: stored } = await browser.storage.local.get('currentRun');
  if (stored && stored.status === 'running') {
    currentRun = stored;
  }
}

async function attemptSaveAsPdf(tabId, siteKey) {
  if (!browser.tabs.saveAsPDF) {
    addLog('Não foi possível localizar um link de download; salve manualmente com Ctrl+P na aba aberta.', 'warn');
    return;
  }
  addLog('Nenhum link direto encontrado — abrindo diálogo "Salvar como PDF" do Firefox (uma confirmação manual).', 'warn');
  try {
    const result = await browser.tabs.saveAsPDF({});
    if (result === 'saved') {
      addLog(`${SITES[siteKey].label}: PDF salvo pelo diálogo do Firefox.`, 'success');
    } else {
      addLog(`${SITES[siteKey].label}: salvamento em PDF cancelado pelo usuário.`, 'warn');
    }
  } catch (err) {
    addLog(`Falha ao chamar o diálogo de salvar PDF: ${err.message || err}`, 'error');
  }
}

async function handleDownloadBlob(msg) {
  const { siteKey, cnpj, dataBase64, mime } = msg;
  const { downloadFolder } = await browser.storage.local.get('downloadFolder');
  const folder = downloadFolder || 'CertFlow';
  const ext = mime && mime.includes('pdf') ? 'pdf' : 'html';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${folder}/${cnpj}/${SITES[siteKey].fileTag}_${timestamp}.${ext}`;

  const byteChars = atob(dataBase64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime || 'application/pdf' });
  const url = URL.createObjectURL(blob);

  try {
    const downloadId = await browser.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
    const { history = [] } = await browser.storage.local.get('history');
    history.unshift({ cnpj, siteKey, filename, downloadId, at: Date.now() });
    await browser.storage.local.set({ history: history.slice(0, 100) });
    addLog(`${SITES[siteKey].label}: arquivo salvo em "${filename}".`, 'success');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function sendLogToApi(events, source) {
  const { apiUrl, apiKey, apiAutoSend } = await browser.storage.local.get(['apiUrl', 'apiKey', 'apiAutoSend']);
  if (!apiAutoSend || !apiUrl || !apiKey) return;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ source: source || 'certflow-extension', runId: currentRun?.runId || null, events }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await browser.storage.local.set({ apiStatus: { ok: true, at: Date.now(), message: 'Envio ok.' } });
  } catch (err) {
    await browser.storage.local.set({
      apiStatus: { ok: false, at: Date.now(), message: String(err && err.message ? err.message : err) },
    });
  }
}

/* Um site falhar não deve travar o run inteiro — marca esse site como
   'error' e segue para o próximo da fila, em vez de parar tudo. O usuário só
   fica sem a certidão daquele site específico, não das duas. */
async function failCurrentSiteAndAdvance(siteKey, reasonMessage) {
  currentRun.siteResults = currentRun.siteResults || {};
  currentRun.siteResults[siteKey] = 'error';
  addLog(`${SITES[siteKey].label}: ${reasonMessage} — pulando para a próxima certidão.`, 'error');
  currentRun.index += 1;
  await advanceToNextJob();
}

function markSiteSuccess(siteKey) {
  currentRun.siteResults = currentRun.siteResults || {};
  currentRun.siteResults[siteKey] = 'success';
}

async function handleCsStatus(msg, sender) {
  if (!currentRun || sender.tab?.id !== currentRun.tabId) return;
  const site = SITES[msg.siteKey];

  switch (msg.status) {
    case 'submitting':
      addLog(`${site.label}: consulta enviada.`);
      break;
    case 'captcha':
      addLog(`${site.label}: captcha detectado — resolva-o na aba aberta para continuar.`, 'warn');
      await setBadge('!', '#c0392b');
      browser.notifications.create({
        type: 'basic',
        iconUrl: browser.runtime.getURL(NOTIFICATION_ICON),
        title: 'CertFlow — ação necessária',
        message: `Resolva o captcha na aba "${site.label}" para continuar.`,
      }).catch(() => {});
      break;
    case 'result_ready':
      addLog(`${site.label}: resultado obtido.`);
      await setBadge('...', '#1f6f4a');
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
      addLog(`${site.label}: IA (Gemini Nano) — ${label}${v.resumo ? ': ' + v.resumo : ''}`, level);
      currentRun.aiVerdicts = currentRun.aiVerdicts || {};
      currentRun.aiVerdicts[msg.siteKey] = v;
      persistRun();
      break;
    }
    case 'emitting':
      addLog(`${site.label}: emitindo certidão...`);
      break;
    case 'temporarily_unavailable': {
      currentRun.retryCount = (currentRun.retryCount || 0) + 1;
      if (currentRun.retryCount > UNAVAILABLE_MAX_RETRIES) {
        await failCurrentSiteAndAdvance(msg.siteKey, `${msg.detail || 'serviço indisponível'} — desistindo após ${UNAVAILABLE_MAX_RETRIES} tentativas`);
        break;
      }
      addLog(`${site.label}: ${msg.detail || 'serviço indisponível'} — nova tentativa (${currentRun.retryCount}/${UNAVAILABLE_MAX_RETRIES}) em ${Math.round(UNAVAILABLE_RETRY_DELAY_MS / 1000)}s.`, 'warn');
      await setBadge('⏳', '#b7791f');
      persistRun();
      await browser.alarms.create(`certflow-retry-${currentRun.runId}`, { when: Date.now() + UNAVAILABLE_RETRY_DELAY_MS });
      break;
    }
    case 'downloaded':
      markSiteSuccess(msg.siteKey);
      currentRun.index += 1;
      await advanceToNextJob();
      break;
    case 'manual_save_needed':
      await attemptSaveAsPdf(currentRun.tabId, msg.siteKey);
      markSiteSuccess(msg.siteKey);
      currentRun.index += 1;
      await advanceToNextJob();
      break;
    case 'error':
      await failCurrentSiteAndAdvance(msg.siteKey, msg.detail || 'erro desconhecido');
      break;
    default:
      break;
  }
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await hydrateRun();
    switch (msg.type) {
      case 'START_RUN': {
        const result = await startRun(msg.cnpj);
        sendResponse(result);
        break;
      }
      case 'GET_RUN_STATE': {
        const { history = [], lastCnpj = '' } = await browser.storage.local.get(['history', 'lastCnpj']);
        sendResponse({ run: currentRun, history, lastCnpj });
        break;
      }
      case 'CANCEL_RUN': {
        if (currentRun) {
          currentRun.status = 'cancelled';
          addLog('Execução cancelada pelo usuário.', 'warn');
          await setBadge('', null);
        }
        sendResponse({ ok: true });
        break;
      }
      case 'CS_READY': {
        if (currentRun && currentRun.status === 'running' && sender.tab?.id === currentRun.tabId && msg.siteKey === currentRun.currentSite) {
          browser.tabs.sendMessage(sender.tab.id, { type: 'RUN_JOB', siteKey: msg.siteKey, cnpj: currentRun.cnpj }).catch(() => {});
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
      case 'DEBUG_LOG': {
        const entry = { at: msg.at, siteKey: msg.siteKey, step: msg.step, detail: msg.detail, snapshot: msg.snapshot };
        const { debugLog = [] } = await browser.storage.local.get('debugLog');
        debugLog.push(entry);
        await browser.storage.local.set({ debugLog: debugLog.slice(-300) });
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
  await startRun(digits);
});

browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus.create({
    id: 'certflow-run-selection',
    title: 'CertFlow: emitir certidões para "%s"',
    contexts: ['selection'],
  });
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('certflow-retry-')) return;
  await hydrateRun();
  if (!currentRun || currentRun.status !== 'running' || alarm.name !== `certflow-retry-${currentRun.runId}`) return;
  const site = SITES[currentRun.currentSite];
  addLog(`${site.label}: tentando novamente...`);
  await setBadge('...', '#1f6f4a');
  await browser.tabs.reload(currentRun.tabId).catch(() => {});
});
