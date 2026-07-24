/* Modo de aprendizado (task mining / process mining): quando ativado nas
   Configurações, observa passivamente os cliques e seleções que o usuário
   faz manualmente nos sites da Receita/Caixa — nunca o texto digitado em
   campos livres (só que o campo foi preenchido, não o valor) — e manda
   isso pelo mesmo canal de log já existente. A API usa essa sequência para
   sugerir passos que a extensão ainda não conhece (ex.: um seletor de UF
   ou uma caixa de "aceito os termos"), do mesmo jeito que já sugere
   seletores de CNPJ/botão hoje: só dados de configuração, nunca código.

   Nunca grava nada enquanto a PRÓPRIA extensão está executando um fluxo
   automatizado nesta aba — só quando é de fato o usuário operando o site
   manualmente (ver window.__certflowAutomatedRun, setado pelo
   rfb-certidoes.js/caixa-crf.js ao receber um RUN_JOB). */
(function () {
  const CNPJ_LIKE = /cnpj/i;
  let lastSnapshotAt = 0;

  function siteKey() {
    return window.__certflowSiteKey || null;
  }

  function activeManualSession() {
    return !window.__certflowAutomatedRun;
  }

  function isCnpjLike(el) {
    return CNPJ_LIKE.test(
      [el.id, el.name, el.getAttribute('formcontrolname'), el.getAttribute('placeholder')].filter(Boolean).join(' ')
    );
  }

  function shouldSnapshotNow() {
    const now = Date.now();
    if (now - lastSnapshotAt > 60000) {
      lastSnapshotAt = now;
      return true;
    }
    return false;
  }

  function describe(el) {
    return `"${CertFlow.textOf(el).slice(0, 80)}" (${CertFlow.elementToSelector(el)})`;
  }

  function onClick(event) {
    const key = siteKey();
    if (!key || !activeManualSession()) return;
    const target = event.target.closest(
      'button, a, input[type="submit"], input[type="checkbox"], input[type="radio"], [role="button"]'
    );
    if (!target || !CertFlow.isVisible(target)) return;
    CertFlow.recordDebug(key, 'observed_click', describe(target), shouldSnapshotNow());
  }

  function onChange(event) {
    const key = siteKey();
    if (!key || !activeManualSession()) return;
    const target = event.target;

    if (target.tagName === 'SELECT') {
      const selected = target.selectedOptions && target.selectedOptions[0];
      const label = selected ? CertFlow.textOf(selected) : '';
      CertFlow.recordDebug(
        key,
        'observed_select',
        `selecionou "${label}" (valor="${target.value}") em (${CertFlow.elementToSelector(target)})`,
        shouldSnapshotNow()
      );
      return;
    }

    if (target.tagName === 'INPUT' && target.type !== 'checkbox' && target.type !== 'radio' && !isCnpjLike(target)) {
      /* Só registra QUE o campo foi preenchido, nunca o que foi digitado —
         o campo de CNPJ nem entra aqui, porque a extensão já sabe lidar
         com ele por heurística própria. */
      CertFlow.recordDebug(key, 'observed_fill', `campo preenchido em (${CertFlow.elementToSelector(target)})`, shouldSnapshotNow());
    }
  }

  async function start() {
    const { taskMiningEnabled } = await browser.storage.local.get('taskMiningEnabled');
    if (!taskMiningEnabled) return;

    /* Manda o site + o retrato de elementos disponíveis já ao ativar o modo
       de aprendizado nessa página, não só reativamente junto do primeiro
       clique observado — assim a API sabe "qual site, quais elementos"
       mesmo que o usuário ainda não tenha interagido, ou nem chegue a
       interagir antes de sair da página. */
    const key = siteKey();
    if (key) {
      CertFlow.recordDebug(key, 'observed_page_context', `Modo de aprendizado ativo — ${location.href}`, true);
      lastSnapshotAt = Date.now();
    }

    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
  }

  start();
})();
