(function () {
  const cnpjInput = document.getElementById('cnpj-input');
  const cnpjError = document.getElementById('cnpj-error');
  const form = document.getElementById('run-form');
  const startBtn = document.getElementById('start-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const logList = document.getElementById('log-list');
  const openOptions = document.getElementById('open-options');
  const stepEls = {
    rfb: document.querySelector('.step[data-site="rfb"]'),
    caixa: document.querySelector('.step[data-site="caixa"]'),
  };

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
    Object.entries(stepEls).forEach(([site, el]) => {
      el.classList.remove('active', 'done', 'error');
      if (!run) return;
      const idx = run.order.indexOf(site);
      if (idx < run.index) el.classList.add('done');
      else if (idx === run.index && run.status === 'running') el.classList.add('active');
      else if (idx === run.index && run.status === 'error') el.classList.add('error');
    });
  }

  function renderRunning(run) {
    const running = !!run && run.status === 'running';
    startBtn.disabled = running;
    startBtn.textContent = running ? 'Executando…' : 'Emitir certidões';
    cancelBtn.hidden = !running;
    renderLog(run);
    renderSteps(run);
  }

  async function refresh() {
    const { run, lastCnpj } = await browser.runtime.sendMessage({ type: 'GET_RUN_STATE' });
    if (!cnpjInput.value && lastCnpj) cnpjInput.value = maskAsYouType(lastCnpj);
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
    startBtn.disabled = true;
    startBtn.textContent = 'Iniciando…';
    const result = await browser.runtime.sendMessage({ type: 'START_RUN', cnpj: digits });
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
  });

  const paramCnpj = new URLSearchParams(window.location.search).get('cnpj');
  if (paramCnpj) {
    const digits = CNPJUtil.onlyDigits(paramCnpj).slice(0, 14);
    cnpjInput.value = maskAsYouType(digits);
  }

  refresh();
})();
