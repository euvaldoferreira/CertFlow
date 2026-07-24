(function () {
  const SITE_PATTERNS = {
    rfb: 'https://servicos.receitafederal.gov.br/*',
    caixa: 'https://consulta-crf.caixa.gov.br/*',
  };
  const SITE_LABELS = {
    rfb: 'Receita Federal',
    caixa: 'Caixa (FGTS)',
  };
  const DEFAULT_API_URL = 'https://api-certflow.ecolmea.com/api/logs';

  async function loadOverrides() {
    const { selectorOverrides = {}, aiAppliedOverrides = {} } = await browser.storage.local.get(['selectorOverrides', 'aiAppliedOverrides']);
    document.querySelectorAll('.site-config').forEach((section) => {
      const siteKey = section.dataset.site;
      section.querySelectorAll('.field-row[data-kind]').forEach((row) => {
        const kind = row.dataset.kind;
        const value = selectorOverrides[siteKey]?.[kind] || '';
        row.querySelector('.selector-value').value = value;

        let badge = row.querySelector('.ai-badge-marker');
        const isAi = !!(value && aiAppliedOverrides[siteKey]?.[kind]);
        if (isAi && !badge) {
          badge = document.createElement('span');
          badge.className = 'ai-badge ai-badge-marker';
          badge.textContent = 'IA';
          badge.title = 'Este seletor foi aplicado automaticamente pela IA';
          row.querySelector('label').appendChild(badge);
        } else if (!isAi && badge) {
          badge.remove();
        }
      });
    });
  }

  async function refreshTabHints() {
    for (const [siteKey, pattern] of Object.entries(SITE_PATTERNS)) {
      const tabs = await browser.tabs.query({ url: pattern });
      const hint = document.querySelector(`.tab-hint[data-site-hint="${siteKey}"]`);
      hint.textContent = tabs.length
        ? `${tabs.length} aba(s) aberta(s) de ${SITE_LABELS[siteKey]} — "Selecionar" usará a mais recente.`
        : `Nenhuma aba do site aberta. Abra ${SITE_LABELS[siteKey]} em uma aba antes de selecionar.`;
    }
  }

  async function loadFolder() {
    const { downloadFolder } = await browser.storage.local.get('downloadFolder');
    document.getElementById('download-folder').value = downloadFolder || 'CertFlow';
  }

  async function loadHistory() {
    const { history = [] } = await browser.storage.local.get('history');
    const body = document.getElementById('history-body');
    body.innerHTML = '';
    history.forEach((entry) => {
      const tr = document.createElement('tr');
      const cells = [
        new Date(entry.at).toLocaleString('pt-BR'),
        CNPJUtil.format(entry.cnpj),
        SITE_LABELS[entry.siteKey] || entry.siteKey,
        entry.filename,
      ];
      cells.forEach((text) => {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  document.querySelectorAll('.pick-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('.field-row');
      const section = btn.closest('.site-config');
      const siteKey = section.dataset.site;
      const kind = row.dataset.kind;
      const pattern = SITE_PATTERNS[siteKey];

      const tabs = await browser.tabs.query({ url: pattern });
      if (!tabs.length) {
        alert(`Abra ${SITE_LABELS[siteKey]} em uma aba antes de selecionar o campo.`);
        return;
      }
      const target = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
      await browser.runtime.sendMessage({ type: 'START_PICKER', siteKey, kind, tabId: target.id });
    });
  });

  document.querySelectorAll('.clear-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('.field-row');
      const section = btn.closest('.site-config');
      const siteKey = section.dataset.site;
      const kind = row.dataset.kind;
      const { selectorOverrides = {}, aiAppliedOverrides = {} } = await browser.storage.local.get(['selectorOverrides', 'aiAppliedOverrides']);
      if (selectorOverrides[siteKey]) delete selectorOverrides[siteKey][kind];
      if (aiAppliedOverrides[siteKey]) delete aiAppliedOverrides[siteKey][kind];
      await browser.storage.local.set({ selectorOverrides, aiAppliedOverrides });
      loadOverrides();
    });
  });

  document.getElementById('save-folder-btn').addEventListener('click', async () => {
    const value = document.getElementById('download-folder').value.trim() || 'CertFlow';
    await browser.storage.local.set({ downloadFolder: value });
  });

  document.getElementById('clear-history-btn').addEventListener('click', async () => {
    await browser.storage.local.set({ history: [] });
    loadHistory();
  });

  async function loadDebugLog() {
    const { debugLog = [] } = await browser.storage.local.get('debugLog');
    document.getElementById('debug-log-count').textContent = debugLog.length
      ? `${debugLog.length} evento(s) registrado(s).`
      : 'Nenhum evento registrado ainda — rode uma emissão para gerar o log.';

    const list = document.getElementById('debug-log-preview');
    list.innerHTML = '';
    debugLog.slice(-25).reverse().forEach((entry) => {
      const li = document.createElement('li');
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = new Date(entry.at).toLocaleTimeString('pt-BR');
      li.appendChild(time);

      const isMissing = /missing|timeout/.test(entry.step || '');
      const label = document.createElement('span');
      if (isMissing) label.className = 'missing';
      label.textContent = `[${SITE_LABELS[entry.siteKey] || entry.siteKey}] ${entry.step}${entry.detail ? ' — ' + entry.detail : ''}`;
      li.appendChild(label);
      list.appendChild(li);
    });
  }

  document.getElementById('download-log-btn').addEventListener('click', async () => {
    const { debugLog = [] } = await browser.storage.local.get('debugLog');
    if (!debugLog.length) {
      alert('Ainda não há eventos registrados. Rode uma emissão primeiro.');
      return;
    }
    const blob = new Blob([JSON.stringify(debugLog, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await browser.downloads.download({ url, filename: `CertFlow/logs/navegacao_${timestamp}.json`, saveAs: false, conflictAction: 'uniquify' });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });

  document.getElementById('clear-log-btn').addEventListener('click', async () => {
    await browser.storage.local.set({ debugLog: [] });
    loadDebugLog();
  });

  async function loadApiConfig() {
    const { apiUrl, apiKey, apiAutoSend } = await browser.storage.local.get(['apiUrl', 'apiKey', 'apiAutoSend']);
    document.getElementById('api-url').value = apiUrl || DEFAULT_API_URL;
    document.getElementById('api-key').value = apiKey || '';
    document.getElementById('api-auto-send').checked = !!apiAutoSend;
    renderApiStatus();
  }

  async function renderApiStatus() {
    const { apiStatus } = await browser.storage.local.get('apiStatus');
    const el = document.getElementById('api-status');
    if (!apiStatus) {
      el.textContent = 'Nenhum envio realizado ainda.';
      el.className = 'tab-hint';
      return;
    }
    const time = new Date(apiStatus.at).toLocaleString('pt-BR');
    el.textContent = apiStatus.ok
      ? `Último envio automático: sucesso às ${time}.`
      : `Último envio automático falhou às ${time}: ${apiStatus.message}`;
    el.className = `tab-hint ${apiStatus.ok ? 'ok' : 'error'}`;
  }

  document.getElementById('save-api-btn').addEventListener('click', async () => {
    const apiUrl = document.getElementById('api-url').value.trim() || DEFAULT_API_URL;
    const apiKey = document.getElementById('api-key').value.trim();
    const apiAutoSend = document.getElementById('api-auto-send').checked;
    await browser.storage.local.set({ apiUrl, apiKey, apiAutoSend });
    alert('Configuração da API salva.');
  });

  document.getElementById('send-log-now-btn').addEventListener('click', async () => {
    const { debugLog = [] } = await browser.storage.local.get('debugLog');
    if (!debugLog.length) {
      alert('Ainda não há eventos registrados. Rode uma emissão primeiro.');
      return;
    }
    const apiUrl = document.getElementById('api-url').value.trim() || DEFAULT_API_URL;
    const apiKey = document.getElementById('api-key').value.trim();
    if (!apiKey) {
      alert('Informe a chave da API antes de enviar (e clique em "Salvar configuração da API").');
      return;
    }
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ source: 'certflow-extension-manual', events: debugLog }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      alert(`Log enviado com sucesso (id ${body.id}).`);
    } catch (err) {
      alert(`Falha ao enviar: ${err.message || err}`);
    }
  });

  const AI_FIELD_LABELS = {
    cnpjInput: 'Campo de CNPJ',
    submitButton: 'Botão consultar',
    emitButton: 'Botão emitir',
    downloadTrigger: 'Link/botão de download',
  };
  const AI_FIELDS = Object.keys(AI_FIELD_LABELS);
  const AI_CONFIDENCE_LABEL = { high: 'alta', medium: 'média', low: 'baixa' };

  async function loadAiConfig() {
    const { aiAutoApply } = await browser.storage.local.get('aiAutoApply');
    document.getElementById('ai-auto-apply').checked = !!aiAutoApply;
  }

  document.getElementById('save-ai-btn').addEventListener('click', async () => {
    const aiAutoApply = document.getElementById('ai-auto-apply').checked;
    await browser.storage.local.set({ aiAutoApply });
    alert('Configuração salva.');
  });

  async function applyAiField(siteKey, field, selector) {
    const { selectorOverrides = {}, aiAppliedOverrides = {} } = await browser.storage.local.get(['selectorOverrides', 'aiAppliedOverrides']);
    selectorOverrides[siteKey] = selectorOverrides[siteKey] || {};
    selectorOverrides[siteKey][field] = selector;
    aiAppliedOverrides[siteKey] = aiAppliedOverrides[siteKey] || {};
    aiAppliedOverrides[siteKey][field] = true;
    await browser.storage.local.set({ selectorOverrides, aiAppliedOverrides });
  }

  async function renderAiSuggestions() {
    const { aiSuggestions = {}, selectorOverrides = {} } = await browser.storage.local.get(['aiSuggestions', 'selectorOverrides']);
    for (const siteKey of ['rfb', 'caixa']) {
      const record = aiSuggestions[siteKey];
      const summaryEl = document.querySelector(`.ai-summary[data-ai-summary="${siteKey}"]`);
      const fieldsEl = document.querySelector(`.ai-fields[data-ai-fields="${siteKey}"]`);
      fieldsEl.innerHTML = '';

      if (!record) {
        summaryEl.textContent = 'Nenhuma análise ainda — clique em "Verificar agora" ou envie o log com o envio automático ligado.';
        continue;
      }

      const when = new Date(record.generatedAt).toLocaleString('pt-BR');
      summaryEl.textContent = `Última análise: ${when} — confiança ${AI_CONFIDENCE_LABEL[record.confidence] || record.confidence}.${record.notes ? ' ' + record.notes : ''}`;

      AI_FIELDS.forEach((field) => {
        const row = document.createElement('div');
        row.className = 'ai-field-row';

        const name = document.createElement('span');
        name.className = 'ai-field-name';
        name.textContent = AI_FIELD_LABELS[field];
        row.appendChild(name);

        const value = document.createElement('span');
        const suggested = record[field];
        value.className = 'ai-field-value' + (suggested ? '' : ' empty');
        value.textContent = suggested || 'sem sugestão';
        row.appendChild(value);

        if (suggested) {
          const applyBtn = document.createElement('button');
          applyBtn.type = 'button';
          applyBtn.className = 'apply-field-btn';
          const alreadyApplied = selectorOverrides[siteKey]?.[field] === suggested;
          applyBtn.textContent = alreadyApplied ? 'Já aplicado' : 'Aplicar';
          applyBtn.disabled = alreadyApplied;
          applyBtn.addEventListener('click', () => applyAiField(siteKey, field, suggested));
          row.appendChild(applyBtn);
        }

        fieldsEl.appendChild(row);
      });
    }
  }

  document.querySelectorAll('.analyze-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const siteKey = btn.dataset.site;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Consultando a IA...';
      try {
        const result = await browser.runtime.sendMessage({ type: 'REQUEST_AI_ANALYSIS', siteKey });
        if (!result.ok) alert(`Falha ao analisar: ${result.error}`);
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });

  browser.storage.onChanged.addListener((changes) => {
    if (changes.selectorOverrides || changes.aiAppliedOverrides) loadOverrides();
    if (changes.history) loadHistory();
    if (changes.debugLog) loadDebugLog();
    if (changes.apiStatus) renderApiStatus();
    if (changes.aiSuggestions || changes.selectorOverrides) renderAiSuggestions();
  });

  loadOverrides();
  refreshTabHints();
  loadFolder();
  loadHistory();
  loadDebugLog();
  loadApiConfig();
  loadAiConfig();
  renderAiSuggestions();
  setInterval(refreshTabHints, 3000);
})();
