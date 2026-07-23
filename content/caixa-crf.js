/* Content script específico da Consulta Regularidade do Empregador (Caixa/FGTS). */
(function () {
  const SITE_KEY = 'caixa';

  browser.runtime.sendMessage({ type: 'CS_READY', siteKey: SITE_KEY }).catch(() => {});

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'RUN_JOB' && msg.siteKey === SITE_KEY) {
      CertFlow.runFlow(SITE_KEY, msg.cnpj);
      sendResponse({ ok: true });
    }
    return undefined;
  });

  CertFlow.registerPickerListener(SITE_KEY);
})();
