(function () {
  const SITE_PATTERNS = {
    rfb: 'https://servicos.receitafederal.gov.br/*',
    caixa: 'https://consulta-crf.caixa.gov.br/*',
  };
  const SITE_LABELS = {
    rfb: 'Receita Federal',
    caixa: 'Caixa (FGTS)',
  };

  async function loadOverrides() {
    const { selectorOverrides = {} } = await browser.storage.local.get('selectorOverrides');
    document.querySelectorAll('.site-config').forEach((section) => {
      const siteKey = section.dataset.site;
      section.querySelectorAll('.field-row[data-kind]').forEach((row) => {
        const kind = row.dataset.kind;
        const value = selectorOverrides[siteKey]?.[kind] || '';
        row.querySelector('.selector-value').value = value;
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
      const { selectorOverrides = {} } = await browser.storage.local.get('selectorOverrides');
      if (selectorOverrides[siteKey]) delete selectorOverrides[siteKey][kind];
      await browser.storage.local.set({ selectorOverrides });
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

  browser.storage.onChanged.addListener((changes) => {
    if (changes.selectorOverrides) loadOverrides();
    if (changes.history) loadHistory();
  });

  loadOverrides();
  refreshTabHints();
  loadFolder();
  loadHistory();
  setInterval(refreshTabHints, 3000);
})();
