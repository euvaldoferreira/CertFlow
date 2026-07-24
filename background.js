/* Orquestra a execução: abre uma aba para cada certidão selecionada — todas
   de uma vez, em paralelo, sem uma esperar a outra terminar — manda o
   content script preencher o CNPJ (quando o site permite automação sem
   login), aguarda captcha/resultado e salva o PDF gerado (ou confirma envio
   por e-mail, dependendo do site). Uma certidão falhar não afeta as outras.
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
    /* Página oficial da consulta — o formulário de verdade só aparece
       dentro de um iframe interno (que ainda dá um meta-refresh para
       consopt.www8.receita.fazenda.gov.br) — por isso o content script
       desse domínio precisa rodar com all_frames:true (ver manifests). */
    url: 'https://www8.receita.fazenda.gov.br/simplesnacional/aplicacoes.aspx?id=21',
    mode: 'auto',
  },
};
const DEFAULT_SELECTED_SITES = ['rfb', 'caixa'];

let currentRun = null;
let popupWindowId = null;

/* Um popup padrão (default_popup) é ancorado pelo próprio navegador perto
   do ícone da extensão — não dá pra reposicionar nem redimensionar por
   CSS. Por isso o manifest não declara default_popup: o clique no ícone
   cai aqui, e abrimos a mesma popup/popup.html como uma janela normal,
   centralizada e ocupando metade da tela. */
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

async function openPopupWindow() {
  if (popupWindowId != null) {
    const existing = await browser.windows.get(popupWindowId).catch(() => null);
    if (existing) {
      await browser.windows.update(popupWindowId, { focused: true });
      return;
    }
    popupWindowId = null;
  }

  const bounds = await getScreenBounds();
  const width = Math.round(bounds.width * 0.5);
  const height = Math.round(bounds.height * 0.5);
  const left = Math.round((bounds.left || 0) + (bounds.width - width) / 2);
  const top = Math.round((bounds.top || 0) + (bounds.height - height) / 2);

  const win = await browser.windows.create({
    url: browser.runtime.getURL('popup/popup.html'),
    type: 'popup',
    width,
    height,
    left,
    top,
  });
  popupWindowId = win.id;
}

browser.action.onClicked.addListener(() => {
  openPopupWindow();
});

browser.windows.onRemoved.addListener((id) => {
  if (id === popupWindowId) popupWindowId = null;
});

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

function findJobByTabId(tabId) {
  if (!currentRun || tabId == null) return null;
  for (const [siteKey, job] of Object.entries(currentRun.jobs)) {
    if (job.tabId === tabId) return { siteKey, job };
  }
  return null;
}

async function startRun(rawCnpj, selectedSites) {
  const cnpj = CNPJUtil.onlyDigits(rawCnpj);
  if (!CNPJUtil.isValid(cnpj)) {
    return { ok: false, error: 'CNPJ inválido.' };
  }
  if (currentRun && currentRun.status === 'running') {
    return { ok: false, error: 'Já existe uma execução em andamento.' };
  }

  const sites = (Array.isArray(selectedSites) && selectedSites.length ? selectedSites : DEFAULT_SELECTED_SITES).filter(
    (s) => SITES[s]
  );
  if (!sites.length) {
    return { ok: false, error: 'Selecione ao menos uma certidão.' };
  }

  currentRun = {
    runId: crypto.randomUUID(),
    cnpj,
    selectedSites: sites,
    jobs: Object.fromEntries(sites.map((siteKey) => [siteKey, { tabId: null, status: 'pending', retryCount: 0 }])),
    status: 'running',
    log: [],
    startedAt: Date.now(),
  };
  await browser.storage.local.set({ lastCnpj: cnpj, selectedCertidoes: sites });
  addLog(`Iniciando emissão para CNPJ ${CNPJUtil.format(cnpj)} — ${sites.map((s) => SITES[s].label).join(', ')}.`);
  await setBadge('...', '#1f6f4a');

  /* Abre todas as abas em paralelo — nenhuma espera a outra terminar. */
  await Promise.all(sites.map((siteKey, i) => startJob(siteKey, i === 0)));
  return { ok: true };
}

async function startJob(siteKey, makeActive) {
  const site = SITES[siteKey];
  const job = currentRun.jobs[siteKey];
  job.status = 'running';

  if (site.mode === 'manual') {
    addLog(`${site.label}: essa certidão exige login — abrindo a aba para você concluir manualmente. Feche a aba quando terminar.`, 'warn');
    const tab = await browser.tabs.create({ url: site.url, active: makeActive });
    job.tabId = tab.id;
    persistRun();
    return;
  }

  await checkAiSuggestion(siteKey);
  addLog(`Abrindo ${site.label}...`);
  const tab = await browser.tabs.create({ url: site.url, active: makeActive });
  job.tabId = tab.id;
  persistRun();
}

function succeedJob(siteKey) {
  if (!currentRun || !currentRun.jobs[siteKey]) return;
  currentRun.jobs[siteKey].status = 'success';
  checkRunCompletion();
}

function failJob(siteKey, reasonMessage) {
  if (!currentRun || !currentRun.jobs[siteKey]) return;
  currentRun.jobs[siteKey].status = 'error';
  addLog(`${SITES[siteKey].label}: ${reasonMessage}.`, 'error');
  checkRunCompletion();
}

async function checkRunCompletion() {
  if (!currentRun) return;
  const jobs = Object.values(currentRun.jobs);
  const allTerminal = jobs.every((j) => j.status === 'success' || j.status === 'error');
  if (!allTerminal) {
    persistRun();
    return;
  }

  const failedSites = Object.entries(currentRun.jobs)
    .filter(([, j]) => j.status === 'error')
    .map(([siteKey]) => SITES[siteKey].label);

  if (failedSites.length) {
    currentRun.status = 'error';
    addLog(`Concluído com falha em: ${failedSites.join(', ')}. As demais certidões foram processadas normalmente.`, 'error');
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
      message: 'Certidões emitidas com sucesso.',
    }).catch(() => {});
  }
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
    addLog(`${SITES[siteKey].label}: IA aplicou automaticamente um seletor para "${field}" (estava sem configuração).`, 'ai');
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
    addLog(`${SITES[siteKey].label}: IA aprendeu e aplicou um passo extra ("${step.role}") observado no modo de aprendizado.`, 'ai');
  }

  if (changed) await browser.storage.local.set({ selectorOverrides, aiAppliedOverrides, extraStepOverrides });
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

async function handleCsStatus(msg, sender) {
  if (!currentRun) return;
  const found = findJobByTabId(sender.tab?.id);
  if (!found || found.siteKey !== msg.siteKey) return;
  const { job } = found;
  const site = SITES[msg.siteKey];

  switch (msg.status) {
    case 'submitting':
      addLog(`${site.label}: consulta enviada.`);
      break;
    case 'captcha':
      addLog(`${site.label}: captcha detectado — resolva-o na aba aberta para continuar.`, 'warn');
      browser.notifications.create({
        type: 'basic',
        iconUrl: browser.runtime.getURL(NOTIFICATION_ICON),
        title: 'CertFlow — ação necessária',
        message: `Resolva o captcha na aba "${site.label}" para continuar.`,
      }).catch(() => {});
      break;
    case 'result_ready':
      addLog(`${site.label}: resultado obtido${msg.detail ? ' — ' + msg.detail : ''}.`, msg.detail?.includes('Positiva') ? 'warn' : 'info');
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
      job.retryCount = (job.retryCount || 0) + 1;
      if (job.retryCount > UNAVAILABLE_MAX_RETRIES) {
        failJob(msg.siteKey, `${msg.detail || 'serviço indisponível'} — desistindo após ${UNAVAILABLE_MAX_RETRIES} tentativas`);
        break;
      }
      addLog(
        `${site.label}: ${msg.detail || 'serviço indisponível'} — nova tentativa (${job.retryCount}/${UNAVAILABLE_MAX_RETRIES}) em ${Math.round(UNAVAILABLE_RETRY_DELAY_MS / 1000)}s.`,
        'warn'
      );
      persistRun();
      await browser.alarms.create(`certflow-retry-${currentRun.runId}-${msg.siteKey}`, { when: Date.now() + UNAVAILABLE_RETRY_DELAY_MS });
      break;
    }
    case 'emailed':
      addLog(`${site.label}: certidão emitida e enviada por e-mail${msg.detail ? ' — ' + msg.detail : ''}. Confira a caixa de entrada (e o spam).`, 'success');
      succeedJob(msg.siteKey);
      break;
    case 'downloaded':
      succeedJob(msg.siteKey);
      break;
    case 'manual_save_needed':
      await attemptSaveAsPdf(job.tabId, msg.siteKey);
      succeedJob(msg.siteKey);
      break;
    case 'error':
      failJob(msg.siteKey, msg.detail || 'erro desconhecido');
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
        sendResponse({
          run: currentRun,
          history,
          lastCnpj,
          availableSites: Object.fromEntries(Object.entries(SITES).map(([k, v]) => [k, { label: v.label, mode: v.mode }])),
          selectedCertidoes: selectedCertidoes && selectedCertidoes.length ? selectedCertidoes : DEFAULT_SELECTED_SITES,
        });
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
        const found = currentRun && currentRun.status === 'running' ? findJobByTabId(sender.tab?.id) : null;
        if (found && found.siteKey === msg.siteKey && found.job.status === 'running') {
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
  const { selectedCertidoes } = await browser.storage.local.get('selectedCertidoes');
  await startRun(digits, selectedCertidoes);
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
  if (!currentRun || currentRun.status !== 'running') return;
  for (const [siteKey, job] of Object.entries(currentRun.jobs)) {
    if (alarm.name === `certflow-retry-${currentRun.runId}-${siteKey}` && job.status === 'running') {
      addLog(`${SITES[siteKey].label}: tentando novamente...`);
      await browser.tabs.reload(job.tabId).catch(() => {});
    }
  }
});

/* Sem isso, fechar a aba de uma certidão manual (Simples Nacional) nunca
   seria percebido como "terminei"; e fechar a aba de uma certidão
   automática no meio do processo deixaria aquele job preso em "running"
   pra sempre, travando a conclusão do run. */
browser.tabs.onRemoved.addListener((tabId) => {
  if (!currentRun || currentRun.status !== 'running') return;
  const found = findJobByTabId(tabId);
  if (!found || found.job.status !== 'running') return;
  const { siteKey, job } = found;

  if (SITES[siteKey].mode === 'manual') {
    job.status = 'success';
    addLog(`${SITES[siteKey].label}: aba fechada — considerando concluído (confira se a certidão foi realmente emitida).`, 'success');
  } else {
    job.status = 'error';
    addLog(`${SITES[siteKey].label}: aba foi fechada antes de terminar.`, 'error');
  }
  checkRunCompletion();
});
