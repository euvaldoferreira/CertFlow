/* Utilidades compartilhadas pelos content scripts de cada site.
   Não usa módulos ES: é carregado como script clássico, na mesma ordem
   declarada no manifest, e expõe tudo em window.CertFlow. */
(function () {
  const CNPJ_INPUT_HINTS = /cnpj/i;
  /* Ordem de prioridade: tentamos achar um botão de emissão explícito antes
     de aceitar um "Consultar" genérico, que em alguns desses portais serve
     para checar a autenticidade de uma certidão já emitida, não para gerar
     uma nova. */
  const SUBMIT_TEXT_PRIORITY = [
    /emitir\s*(a\s*)?(nova\s*)?certid[aã]o/i,
    /gerar\s*(a\s*)?(nova\s*)?certid[aã]o/i,
    /emitir\s*certificado/i,
    /nova\s*consulta/i,
    /consultar/i,
    /pesquisar|buscar|verificar/i,
  ];
  const EMIT_STEP_TEXT_HINTS = /emitir\s*(a\s*)?(nova\s*)?certid[aã]o|gerar\s*(a\s*)?(nova\s*)?certid[aã]o|emitir\s*certificado/i;
  /* Seções do tipo "consultar autenticidade de certidão emitida" (por número
     de controle) existem nesses portais ao lado da emissão — descartamos
     campos/botões que estejam dentro de um bloco assim marcado. */
  const EXCLUDE_CONTEXT_HINTS = /autenticidade|n[uú]mero de controle|certid[aã]o j[aá] emitida|validar certid[aã]o|consultar certid[aã]o emitida/i;
  const CAPTCHA_HINTS = /recaptcha|hcaptcha|h-captcha|g-recaptcha|captcha/i;
  const RESULT_TEXT_HINTS = /certid[aã]o emitida|situa[cç][aã]o regular|regular perante|certificado de regularidade|v[aá]lida at[eé]|n[uú]mero da certid[aã]o|n[uú]mero do certificado/i;
  const DOWNLOAD_TEXT_HINTS = /baixar|salvar|download|imprimir|gerar pdf|visualizar certid[aã]o|visualizar certificado/i;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(predicate, { timeout = 20000, interval = 300 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = predicate();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function textOf(el) {
    return (el.innerText || el.textContent || el.value || '').trim();
  }

  /* Define o valor de um input "controlado" (Angular/React) disparando os
     eventos nativos que os frameworks escutam para atualizar seu estado
     interno — atribuir `.value` diretamente é ignorado por eles. */
  function setNativeValue(element, value) {
    const proto = Object.getPrototypeOf(element);
    const descriptor =
      Object.getOwnPropertyDescriptor(element, 'value') ||
      Object.getOwnPropertyDescriptor(proto, 'value') ||
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(proto), 'value');

    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  /* Sobe no DOM até achar um limite semântico razoável (painel de aba,
     card, section, fieldset, ou um bloco com título próprio) para poder
     ler o "assunto" daquele pedaço da página e descartar campos que
     pertençam a uma seção de "consultar autenticidade", não de emissão. */
  function closestNamedSection(el) {
    let node = el.parentElement;
    let depth = 0;
    while (node && depth < 8) {
      if (node.matches?.('[role="tabpanel"], .tab-pane, .tab-content, .card, .panel, section, fieldset')) {
        return node;
      }
      if (node.querySelector?.(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > legend')) {
        return node;
      }
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  function isInExcludedContext(el) {
    const section = closestNamedSection(el);
    if (!section) return false;
    const text = textOf(section);
    return EXCLUDE_CONTEXT_HINTS.test(text) && !EMIT_STEP_TEXT_HINTS.test(text);
  }

  function findCnpjInputHeuristic() {
    const inputs = Array.from(document.querySelectorAll('input'))
      .filter(isVisible)
      .filter((el) => !isInExcludedContext(el));

    const rank = (el) => (/emitir/i.test(textOf(closestNamedSection(el) || document.body)) ? 0 : 1);

    const byAttr = inputs
      .filter((el) =>
        [el.id, el.name, el.getAttribute('formcontrolname'), el.getAttribute('placeholder'), el.getAttribute('aria-label')]
          .filter(Boolean)
          .some((attr) => CNPJ_INPUT_HINTS.test(attr))
      )
      .sort((a, b) => rank(a) - rank(b));
    if (byAttr[0]) return byAttr[0];

    const labels = Array.from(document.querySelectorAll('label')).filter((l) => !isInExcludedContext(l));
    const cnpjLabel = labels.find((l) => CNPJ_INPUT_HINTS.test(textOf(l)));
    if (cnpjLabel) {
      if (cnpjLabel.htmlFor) {
        const el = document.getElementById(cnpjLabel.htmlFor);
        if (el && isVisible(el) && !isInExcludedContext(el)) return el;
      }
      const nearby = cnpjLabel.closest('div, fieldset, mat-form-field, .form-group')?.querySelector('input');
      if (nearby && isVisible(nearby) && !isInExcludedContext(nearby)) return nearby;
    }

    return inputs.find((el) => el.maxLength === 14 || el.maxLength === 18) || null;
  }

  /* `hints` pode ser um regex único ou uma lista de regex em ordem de
     prioridade — a primeira que casar com algum botão visível vence. */
  function findButtonHeuristic(hints) {
    const patterns = Array.isArray(hints) ? hints : [hints];
    const candidates = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn, a[role="button"]'))
      .filter(isVisible)
      .filter((el) => !el.disabled)
      .filter((el) => !isInExcludedContext(el));

    for (const pattern of patterns) {
      const match = candidates.find((el) => pattern.test(textOf(el)));
      if (match) return match;
    }
    return null;
  }

  function detectCaptcha() {
    const iframe = Array.from(document.querySelectorAll('iframe')).find(
      (f) => isVisible(f) && CAPTCHA_HINTS.test(f.src || '') || CAPTCHA_HINTS.test(f.title || '')
    );
    if (iframe) return { present: true, el: iframe };

    const widget = Array.from(document.querySelectorAll('div, section')).find(
      (el) => isVisible(el) && Array.from(el.classList).some((c) => CAPTCHA_HINTS.test(c))
    );
    if (widget) return { present: true, el: widget };

    return { present: false, el: null };
  }

  function detectResult() {
    const bodyText = document.body.innerText || '';
    return RESULT_TEXT_HINTS.test(bodyText);
  }

  function findDownloadTrigger() {
    const directLink = Array.from(document.querySelectorAll('a[href$=".pdf"], a[href*=".pdf?"]')).find(isVisible);
    if (directLink) return { kind: 'link', el: directLink };

    const button = findButtonHeuristic(DOWNLOAD_TEXT_HINTS);
    if (button) return { kind: 'button', el: button };

    return null;
  }

  function elementToSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const attrPriority = ['formcontrolname', 'name', 'data-testid', 'aria-label'];
    for (const attr of attrPriority) {
      const val = el.getAttribute(attr);
      if (val) return `[${attr}="${CSS.escape(val)}"]`;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let selector = node.tagName.toLowerCase();
      if (node.classList.length) {
        selector += '.' + Array.from(node.classList).map((c) => CSS.escape(c)).join('.');
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) {
          selector += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
      }
      parts.unshift(selector);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  /* Retrato estrutural da página no momento — só atributos/rótulos, nunca
     valores digitados ou conteúdo da certidão. Serve para depurar por que a
     detecção automática errou um campo, sem expor dados sensíveis no log. */
  function snapshotPage() {
    const inputs = Array.from(document.querySelectorAll('input'))
      .filter(isVisible)
      .slice(0, 30)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.type,
        id: el.id || null,
        name: el.name || null,
        formcontrolname: el.getAttribute('formcontrolname'),
        placeholder: el.getAttribute('placeholder'),
        ariaLabel: el.getAttribute('aria-label'),
        maxLength: el.maxLength > 0 ? el.maxLength : null,
        excludedContext: isInExcludedContext(el),
        selector: elementToSelector(el),
      }));

    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn, a[role="button"], a'))
      .filter(isVisible)
      .filter((el) => {
        const t = textOf(el);
        return t.length > 0 && t.length < 60;
      })
      .slice(0, 40)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: textOf(el),
        isLink: el.tagName === 'A',
        excludedContext: isInExcludedContext(el),
        selector: elementToSelector(el),
      }));

    return { title: document.title, url: location.href, inputs, buttons };
  }

  function recordDebug(siteKey, step, detail, snapshot) {
    browser.runtime
      .sendMessage({
        type: 'DEBUG_LOG',
        siteKey,
        step,
        detail,
        snapshot: snapshot ? snapshotPage() : null,
        at: Date.now(),
      })
      .catch(() => {});
  }

  function resolveElement(kind, siteKey, overrides, heuristicFn) {
    const override = overrides && overrides[siteKey] && overrides[siteKey][kind];
    if (override) {
      const el = document.querySelector(override);
      if (el) return el;
    }
    return heuristicFn();
  }

  async function fetchAsBase64(url) {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return {
      base64: btoa(binary),
      mime: response.headers.get('content-type') || 'application/pdf',
    };
  }

  function enablePickerMode(kind, onPicked) {
    const overlay = document.createElement('div');
    overlay.textContent = `CertFlow: clique no elemento correspondente a "${kind}" (Esc para cancelar)`;
    Object.assign(overlay.style, {
      position: 'fixed', top: '0', left: '0', right: '0', zIndex: 2147483647,
      background: '#1f6f4a', color: '#fff', padding: '8px 12px',
      font: '13px/1.4 sans-serif', textAlign: 'center', boxShadow: '0 2px 6px rgba(0,0,0,.3)',
    });
    document.documentElement.appendChild(overlay);

    let highlighted = null;
    const outlineStyle = '2px solid #2f9e5c';

    function clearHighlight() {
      if (highlighted) highlighted.style.outline = '';
    }

    function onMouseOver(e) {
      clearHighlight();
      highlighted = e.target;
      highlighted.style.outline = outlineStyle;
    }

    function cleanup() {
      clearHighlight();
      document.removeEventListener('mouseover', onMouseOver, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
    }

    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();
      const selector = elementToSelector(e.target);
      cleanup();
      onPicked(selector);
    }

    function onKeydown(e) {
      if (e.key === 'Escape') {
        cleanup();
        onPicked(null);
      }
    }

    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown, true);
  }

  function sendStatus(siteKey, status, detail) {
    browser.runtime.sendMessage({ type: 'CS_STATUS', siteKey, status, detail }).catch(() => {});
  }

  /* Fluxo genérico reaproveitado pelos dois sites: preenche o CNPJ, envia o
     formulário, aguarda captcha (se aparecer) e resultado, e então localiza
     um jeito de salvar o PDF — link direto (download silencioso) ou botão
     de imprimir/baixar (fallback pedindo 1 clique ao usuário via background). */
  async function runFlow(siteKey, cnpj) {
    try {
      recordDebug(siteKey, 'start', `URL: ${location.href}`, true);
      const { selectorOverrides = {} } = await browser.storage.local.get('selectorOverrides');

      /* Apps Angular/JSF ainda podem estar renderizando quando o content
         script injeta — espera o campo aparecer em vez de checar uma vez só. */
      const input = await waitFor(
        () => resolveElement('cnpjInput', siteKey, selectorOverrides, findCnpjInputHeuristic),
        { timeout: 20000, interval: 400 }
      );
      if (!input) {
        recordDebug(siteKey, 'cnpj_input_missing', 'Nenhum campo de CNPJ encontrado pela heurística nem por override.', true);
        sendStatus(siteKey, 'error', 'Campo de CNPJ não encontrado. Use "Selecionar na página" nas opções da extensão.');
        return;
      }
      recordDebug(siteKey, 'cnpj_input_found', elementToSelector(input));
      setNativeValue(input, cnpj);
      await sleep(300);

      const submit = await waitFor(
        () => resolveElement('submitButton', siteKey, selectorOverrides, () => findButtonHeuristic(SUBMIT_TEXT_PRIORITY)),
        { timeout: 8000, interval: 300 }
      );
      if (!submit) {
        recordDebug(siteKey, 'submit_missing', 'Nenhum botão de consulta encontrado pela heurística nem por override.', true);
        sendStatus(siteKey, 'error', 'Botão de consulta não encontrado. Use "Selecionar na página" nas opções da extensão.');
        return;
      }
      recordDebug(siteKey, 'submit_found', `"${textOf(submit)}" (${elementToSelector(submit)})`);
      sendStatus(siteKey, 'submitting');
      submit.click();

      const captchaCheck = await waitFor(() => {
        const captcha = detectCaptcha();
        if (captcha.present) return { type: 'captcha' };
        if (detectResult()) return { type: 'result' };
        return null;
      }, { timeout: 15000, interval: 400 });

      if (captchaCheck && captchaCheck.type === 'captcha') {
        recordDebug(siteKey, 'captcha_detected', 'Captcha visível após o envio.');
        sendStatus(siteKey, 'captcha');
        const resolved = await waitFor(() => detectResult(), { timeout: 300000, interval: 800 });
        if (!resolved) {
          recordDebug(siteKey, 'captcha_timeout', 'Resultado não apareceu após resolução do captcha (5 min).', true);
          sendStatus(siteKey, 'error', 'Tempo esgotado aguardando a resolução do captcha.');
          return;
        }
      } else if (!captchaCheck) {
        const resolvedLate = await waitFor(() => detectResult(), { timeout: 15000, interval: 500 });
        if (!resolvedLate) {
          recordDebug(siteKey, 'result_missing', 'Nenhum texto de resultado reconhecido após o envio.', true);
          sendStatus(siteKey, 'error', 'A página não retornou um resultado reconhecível. Verifique o CNPJ ou ajuste os seletores.');
          return;
        }
      }

      recordDebug(siteKey, 'result_detected', `URL: ${location.href}`);
      sendStatus(siteKey, 'result_ready');
      await sleep(500);

      /* Alguns desses portais mostram a "situação" numa primeira consulta e
         só geram o PDF da certidão depois de um clique explícito em
         "Emitir certidão" — se esse botão existir, aciona-o antes de
         procurar o link de download. */
      const emitBtn = resolveElement('emitButton', siteKey, selectorOverrides, () => findButtonHeuristic([EMIT_STEP_TEXT_HINTS]));
      if (emitBtn && isVisible(emitBtn) && !emitBtn.disabled) {
        recordDebug(siteKey, 'emit_button_found', `"${textOf(emitBtn)}" (${elementToSelector(emitBtn)})`);
        sendStatus(siteKey, 'emitting');
        emitBtn.click();
        await waitFor(() => findDownloadTrigger(), { timeout: 20000, interval: 500 });
      }

      const trigger = resolveElement('downloadTrigger', siteKey, selectorOverrides, findDownloadTrigger);
      if (!trigger) {
        recordDebug(siteKey, 'download_trigger_missing', 'Nenhum link .pdf nem botão de baixar/salvar/imprimir encontrado.', true);
        sendStatus(siteKey, 'manual_save_needed');
        return;
      }
      recordDebug(siteKey, 'download_trigger_found', elementToSelector(trigger.el || trigger));

      const el = trigger.el || trigger;
      const href = el.tagName === 'A' ? el.href : null;

      if (href && /\.pdf($|\?)/i.test(href)) {
        const { base64, mime } = await fetchAsBase64(href);
        browser.runtime.sendMessage({ type: 'DOWNLOAD_BLOB', siteKey, cnpj, dataBase64: base64, mime }).catch(() => {});
        sendStatus(siteKey, 'downloaded');
        return;
      }

      el.click();
      await sleep(1500);

      const blobLink = Array.from(document.querySelectorAll('a[href^="blob:"], embed[src^="blob:"], iframe[src^="blob:"]')).find(isVisible);
      const blobUrl = blobLink && (blobLink.href || blobLink.src);
      if (blobUrl) {
        const { base64, mime } = await fetchAsBase64(blobUrl);
        browser.runtime.sendMessage({ type: 'DOWNLOAD_BLOB', siteKey, cnpj, dataBase64: base64, mime }).catch(() => {});
        sendStatus(siteKey, 'downloaded');
        return;
      }

      sendStatus(siteKey, 'manual_save_needed');
    } catch (err) {
      sendStatus(siteKey, 'error', String(err && err.message ? err.message : err));
    }
  }

  window.CertFlow = {
    sleep,
    waitFor,
    isVisible,
    textOf,
    setNativeValue,
    findCnpjInputHeuristic,
    findButtonHeuristic,
    detectCaptcha,
    detectResult,
    findDownloadTrigger,
    elementToSelector,
    resolveElement,
    fetchAsBase64,
    enablePickerMode,
    runFlow,
    snapshotPage,
    recordDebug,
    SUBMIT_TEXT_PRIORITY,
  };

  function registerPickerListener(siteKey) {
    browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'START_PICKER' && msg.siteKey === siteKey) {
        enablePickerMode(msg.kind, (selector) => {
          browser.runtime.sendMessage({ type: 'PICKER_RESULT', siteKey, kind: msg.kind, selector }).catch(() => {});
        });
        sendResponse({ ok: true });
      }
      return undefined;
    });
  }

  window.CertFlow.registerPickerListener = registerPickerListener;
})();
