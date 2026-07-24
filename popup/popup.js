(function () {
  const cnpjInput = document.getElementById('cnpj-input');
  const cnpjError = document.getElementById('cnpj-error');
  const form = document.getElementById('run-form');
  const startBtn = document.getElementById('start-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const logList = document.getElementById('log-list');
  const openOptions = document.getElementById('open-options');
  const siteCheckboxes = document.getElementById('site-checkboxes');
  const stepsSection = document.getElementById('steps');

  let availableSites = {};

  function maskAsYouType(digits) {
    let out = digits;
    if (digits.length > 12) out = digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{0,2}).*/, '$1.$2.$3/$4-$5');
    else if (digits.length > 8) out = digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{0,4}).*/, '$1.$2.$3/$4');
    else if (digits.length > 5) out = digits.replace(/^(\d{2})(\d{3})(\d{0,3}).*/, '$1.$2.$3');
    else if (digits.length > 2) out = digits.replace(/^(\d{2})(\d{0,3}).*/, '$1.$2');
    return out;
  }

  cnpjInput.addEventListener('input', () => {
    const digits = CNPJUtil.onlyDigits(cnpjInput.value).slice(0, 14);
    cnpjInput.value = maskAsYouType(digits);
    cnpjError.hidden = true;
  });

  function getSelectedSites() {
    return Array.from(siteCheckboxes.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => cb.value);
  }

  function renderSiteCheckboxes(sites, selected) {
    const selectedSet = new Set(selected && selected.length ? selected : Object.keys(sites));
    siteCheckboxes.innerHTML = '';
    Object.entries(sites).forEach(([siteKey, info]) => {
      const label = document.createElement('label');
      label.className = 'site-checkbox';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = siteKey;
      cb.checked = selectedSet.has(siteKey);
      cb.addEventListener('change', () => {
        browser.storage.local.set({ selectedCertidoes: getSelectedSites() });
      });

      const span = document.createElement('span');
      span.textContent = info.label + (info.mode === 'manual' ? ' (manual — exige login gov.br)' : '');

      label.appendChild(cb);
      label.appendChild(span);
      siteCheckboxes.appendChild(label);
    });
  }

  function renderLog(run) {
    logList.innerHTML = '';
    (run?.log || []).forEach((entry) => {
      const li = document.createElement('li');
      li.textContent = entry.message;
      if (entry.level && entry.level !== 'info') li.className = entry.level;
      logList.appendChild(li);
    });
    logList.scrollTop = logList.scrollHeight;
  }

  function renderSteps(run) {
    stepsSection.innerHTML = '';
    if (!run) return;
    (run.selectedSites || []).forEach((siteKey) => {
      const job = run.jobs?.[siteKey];
      const div = document.createElement('div');
      div.className = 'step';
      div.dataset.site = siteKey;

      const dot = document.createElement('span');
      dot.className = 'dot';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = availableSites[siteKey]?.label || siteKey;
      div.appendChild(dot);
      div.appendChild(label);

      if (job?.status === 'success' && job?.outcome === 'no_certificate') {
        div.classList.add('done-no-cert');
        div.title = 'Processo concluído, mas não havia certidão para extrair — a tela foi salva.';
        const badge = document.createElement('span');
        badge.className = 'badge-no-cert';
        badge.textContent = 'sem certidão';
        div.appendChild(badge);
      } else if (job?.status === 'success') {
        div.classList.add('done');
      } else if (job?.status === 'error') {
        div.classList.add('error');
      } else if (run.status === 'running' && (job?.status === 'running' || job?.status === 'pending')) {
        div.classList.add('active');
      }

      stepsSection.appendChild(div);
    });
  }

  function renderRunning(run) {
    const running = !!run && run.status === 'running';
    startBtn.disabled = running;
    startBtn.textContent = running ? 'Executando…' : 'Emitir certidões';
    cancelBtn.hidden = !running;
    siteCheckboxes.querySelectorAll('input').forEach((cb) => {
      cb.disabled = running;
    });
    renderLog(run);
    renderSteps(run);
  }

  async function refresh() {
    const { run, lastCnpj, availableSites: sites, selectedCertidoes } = await browser.runtime.sendMessage({ type: 'GET_RUN_STATE' });
    availableSites = sites || {};
    if (!cnpjInput.value && lastCnpj) cnpjInput.value = maskAsYouType(lastCnpj);
    if (!siteCheckboxes.childElementCount) {
      renderSiteCheckboxes(availableSites, (run && run.selectedSites) || selectedCertidoes || []);
    }
    renderRunning(run);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const digits = CNPJUtil.onlyDigits(cnpjInput.value);
    if (!CNPJUtil.isValid(digits)) {
      cnpjError.textContent = 'CNPJ inválido. Confira os dígitos.';
      cnpjError.hidden = false;
      return;
    }
    const selectedSites = getSelectedSites();
    if (!selectedSites.length) {
      cnpjError.textContent = 'Selecione ao menos uma certidão.';
      cnpjError.hidden = false;
      return;
    }
    startBtn.disabled = true;
    startBtn.textContent = 'Iniciando…';
    const result = await browser.runtime.sendMessage({ type: 'START_RUN', cnpj: digits, selectedSites });
    if (!result.ok) {
      cnpjError.textContent = result.error;
      cnpjError.hidden = false;
      startBtn.disabled = false;
      startBtn.textContent = 'Emitir certidões';
      return;
    }
    refresh();
  });

  cancelBtn.addEventListener('click', async () => {
    await browser.runtime.sendMessage({ type: 'CANCEL_RUN' });
    refresh();
  });

  openOptions.addEventListener('click', (e) => {
    e.preventDefault();
    browser.runtime.openOptionsPage();
  });

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'RUN_UPDATE') renderRunning(msg.run);
    if (msg.type === 'PREFILL_CNPJ' && msg.cnpj) {
      cnpjInput.value = maskAsYouType(CNPJUtil.onlyDigits(msg.cnpj).slice(0, 14));
      cnpjError.hidden = true;
    }
  });

  const paramCnpj = new URLSearchParams(window.location.search).get('cnpj');
  if (paramCnpj) {
    const digits = CNPJUtil.onlyDigits(paramCnpj).slice(0, 14);
    cnpjInput.value = maskAsYouType(digits);
  }

  refresh();
})();
