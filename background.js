/* Orquestra a execução: abre cada site em sequência, manda o content script
   preencher o CNPJ, aguarda captcha/resultado e salva o PDF gerado.
   CNPJUtil vem de lib/cnpj.js, carregado antes deste arquivo pelo manifest. */

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
    cnpj,
    order: RUN_ORDER.slice(),
    index: 0,
    tabId: null,
    status: 'running',
    log: [],
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
    currentRun.status = 'done';
    addLog('Todas as certidões foram processadas.', 'success');
    await setBadge('OK', '#2f9e5c');
    browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon.svg'),
      title: 'CertFlow',
      message: 'Certidões emitidas e salvas com sucesso.',
    }).catch(() => {});
    return;
  }

  const siteKey = currentRun.order[currentRun.index];
  const site = SITES[siteKey];
  addLog(`Abrindo ${site.label}...`);
  const tab = await browser.tabs.create({ url: site.url, active: true });
  currentRun.tabId = tab.id;
  currentRun.currentSite = siteKey;
  persistRun();
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
        iconUrl: browser.runtime.getURL('icons/icon.svg'),
        title: 'CertFlow — ação necessária',
        message: `Resolva o captcha na aba "${site.label}" para continuar.`,
      }).catch(() => {});
      break;
    case 'result_ready':
      addLog(`${site.label}: resultado obtido.`);
      await setBadge('...', '#1f6f4a');
      break;
    case 'downloaded':
      currentRun.index += 1;
      await advanceToNextJob();
      break;
    case 'manual_save_needed':
      await attemptSaveAsPdf(currentRun.tabId, msg.siteKey);
      currentRun.index += 1;
      await advanceToNextJob();
      break;
    case 'error':
      addLog(`${site.label}: ${msg.detail || 'erro desconhecido'}`, 'error');
      currentRun.status = 'error';
      await setBadge('X', '#c0392b');
      persistRun();
      break;
    default:
      break;
  }
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
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
          const { selectorOverrides = {} } = await browser.storage.local.get('selectorOverrides');
          selectorOverrides[msg.siteKey] = selectorOverrides[msg.siteKey] || {};
          selectorOverrides[msg.siteKey][msg.kind] = msg.selector;
          await browser.storage.local.set({ selectorOverrides });
        }
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
      iconUrl: browser.runtime.getURL('icons/icon.svg'),
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
