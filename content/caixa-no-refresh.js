/* Bloqueia o auto-refresh (<meta http-equiv="refresh">) da página de
   Consulta Regularidade do Empregador da Caixa — sem isso, a página se
   recarrega sozinha periodicamente e o resultado (Visualizar/Imprimir)
   some da tela antes de dar tempo de salvar a certidão. Roda em
   document_start, o mais cedo possível, e continua observando o <head>
   caso o site injete a tag via JS depois (ex.: aviso de sessão expirando). */
(function () {
  function removeMetaRefresh() {
    document.querySelectorAll('meta').forEach((el) => {
      if ((el.getAttribute('http-equiv') || '').toLowerCase() === 'refresh') {
        el.remove();
      }
    });
  }

  removeMetaRefresh();

  const observer = new MutationObserver(removeMetaRefresh);
  const startObserving = () => {
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  };
  if (document.documentElement) {
    startObserving();
  } else {
    document.addEventListener('DOMContentLoaded', startObserving, { once: true });
  }
})();
