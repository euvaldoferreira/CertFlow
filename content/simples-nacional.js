/* Content script específico da Consulta Optantes do Simples Nacional. */
(function () {
  const SITE_KEY = 'simples';
  /* content/task-mining.js (mesmo escopo global de content script) usa isso
     para saber em qual site está e para nunca gravar os próprios cliques
     automatizados da extensão como se fossem uma demonstração do usuário. */
  window.__certflowSiteKey = SITE_KEY;

  browser.runtime.sendMessage({ type: 'CS_READY', siteKey: SITE_KEY }).catch(() => {});

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'RUN_JOB' && msg.siteKey === SITE_KEY) {
      window.__certflowAutomatedRun = true;
      CertFlow.runFlow(SITE_KEY, msg.cnpj);
      sendResponse({ ok: true });
    }
    return undefined;
  });

  CertFlow.registerPickerListener(SITE_KEY);
})();
