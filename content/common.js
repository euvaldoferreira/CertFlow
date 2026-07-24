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
  /* O fluxo real da Caixa (confirmado observando o site) tem duas etapas
     depois do resultado da consulta: "Visualizar" (input#mainForm:btnVisualizar)
     leva a uma segunda página, que só então mostra o botão "Imprimir"
     (já coberto por DOWNLOAD_TEXT_HINTS mais abaixo). "Obter Certificado"
     e "Confirmar emissão" continuam aqui como variantes de outros portais
     que possam usar uma etapa de emissão nomeada de forma diferente. */
  const EMIT_STEP_TEXT_HINTS = /emitir\s*(a\s*)?(nova\s*)?certid[aã]o|gerar\s*(a\s*)?(nova\s*)?certid[aã]o|emitir\s*certificado|obter\s*(o\s*)?certificado|obter\s*(a\s*)?certid[aã]o|gerar\s*certificado|confirmar\s*(a\s*)?emiss[aã]o|\bvisualizar\b/i;
  /* Seções do tipo "consultar autenticidade de certidão emitida" (por número
     de controle) existem nesses portais ao lado da emissão — descartamos
     campos/botões que estejam dentro de um bloco assim marcado. */
  const EXCLUDE_CONTEXT_HINTS = /autenticidade|n[uú]mero de controle|certid[aã]o j[aá] emitida|validar certid[aã]o|consultar certid[aã]o emitida/i;
  const CAPTCHA_HINTS = /recaptcha|hcaptcha|h-captcha|g-recaptcha|captcha/i;
  const RESULT_TEXT_HINTS = /certid[aã]o emitida|situa[cç][aã]o regular|regular perante|certificado de regularidade|v[aá]lida at[eé]|n[uú]mero da certid[aã]o|n[uú]mero do certificado|certid[aã]o v[aá]lida encontrada|j[aá] existe uma certid[aã]o v[aá]lida/i;
  /* A Receita Federal pode devolver três resultados diferentes para o
     mesmo CNPJ — todos geram um PDF para baixar, mas o usuário precisa
     saber qual saiu. Ordem de checagem importa: "positiva com efeitos de
     negativa" também contém a palavra "positiva", então tem que ser
     testada antes do padrão genérico de "positiva". */
  const RESULT_POSITIVA_PENDENCIA_HINTS = /positiva\s+com\s+efeitos\s+de\s+negativa/i;
  const RESULT_POSITIVA_HINTS = /certid[aã]o\s+positiva\s+de\s+d[eé]bitos|situa[cç][aã]o\s+irregular/i;
  const RESULT_NEGATIVA_HINTS = /certid[aã]o\s+negativa\s+de\s+d[eé]bitos|nada\s+consta/i;
  /* Estados em que o site definitivamente NÃO vai gerar uma certidão para
     esse CNPJ agora (CNPJ inválido, empregador não cadastrado no FGTS,
     dados insuficientes para certificação automática) — bem diferentes de
     "indisponibilidade temporária": aqui não adianta tentar de novo, o
     certo é reportar e passar para a próxima certidão da fila. */
  const RESULT_BLOCKED_HINTS = /cnpj\s+inv[aá]lido|cnpj\s+n[aã]o\s+(consta|encontrado|cadastrado|localizado)|empregador\s+n[aã]o\s+(est[aá]\s+)?cadastrado|n[aã]o\s+foi\s+poss[ií]vel\s+(emitir|processar|confirmar)|informa[cç][oõ]es\s+dispon[ií]veis\s+n[aã]o\s+s[aã]o\s+suficientes|imped(e|imento)s?\s+(a|à)\s+certifica[cç][aã]o|n[aã]o\s+[eé]\s+poss[ií]vel\s+emitir/i;
  /* Consulta Optantes do Simples Nacional não fala em "certidão" — o
     resultado é uma frase dizendo se o CNPJ é (ou não) optante. As duas
     variantes contêm "optante pelo simples nacional", então a diferença
     entre optante/não-optante fica só no rótulo de log, não na detecção
     de resultado (ambas são respostas válidas da consulta, não falhas). */
  const RESULT_SIMPLES_NAO_OPTANTE_HINTS = /n[aã]o\s+(consta\s+como\s+|é\s+|est[aá]\s+)?optante\s+pelo\s+simples\s+nacional/i;
  const RESULT_SIMPLES_OPTANTE_HINTS = /optante\s+pelo\s+simples\s+nacional/i;
  /* Mensagem observada na Caixa: "Constam impedimentos na CAIXA para a
     comprovação da regularidade do empregador no FGTS. Para mais
     informações, clique aqui https://conectividadesocialv2.caixa.gov.br."
     Diferente de RESULT_BLOCKED_HINTS (CNPJ inválido, etc.), aqui a
     consulta funcionou e deu uma resposta definitiva — só que não existe
     certificado nenhum pra baixar. Trata como processo concluído (salva a
     tela em PDF), não como erro. */
  const RESULT_CAIXA_IMPEDIMENTO_HINTS = /imped(imento|imentos)\s+na\s+caixa\s+para\s+a\s+comprova[cç][aã]o\s+da\s+regularidade/i;
  /* RFB: quando já existe uma certidão de Pessoa Jurídica válida emitida
     para o CNPJ, o site mostra essa tela em vez de emitir uma nova — o
     fluxo correto aqui não é clicar em "Emitir Nova Certidão" (like nos
     outros resultados), e sim em "Consultar", que leva a uma tela onde é
     preciso escolher a opção "data de validade" e um intervalo de datas
     (ver handleRfbExistingCertidaoFlow). */
  const RESULT_CERTIDAO_VALIDA_HINTS = /certid[aã]o\s+v[aá]lida\s+encontrada|j[aá]\s+existe\s+uma\s+certid[aã]o\s+v[aá]lida/i;
  const RESULT_CLASSIFICATION_LABEL = {
    negativa: 'Certidão Negativa (regular, sem pendências)',
    positiva_com_pendencia: 'Certidão Positiva com Efeitos de Negativa (há pendências, mas suspensas)',
    positiva: 'Certidão Positiva (débitos ativos) ou situação irregular',
    regular: 'Situação regular',
    simples_nao_optante: 'CNPJ não optante pelo Simples Nacional',
    simples_optante: 'CNPJ optante pelo Simples Nacional',
    impedimento_caixa: 'Impedimento na Caixa para comprovação de regularidade (ver Conectividade Social)',
    certidao_valida_existente: 'Certidão válida já existente (consultando por data de validade)',
  };
  /* Mensagem observada na prática: "O serviço de emissão de certidão está
     temporariamente indisponível. Tente novamente em alguns minutos." —
     não é captcha nem resultado, é uma falha transitória do próprio site
     que vale a pena tentar de novo automaticamente em vez de desistir. */
  const TEMP_UNAVAILABLE_HINTS = /temporariamente indispon[ií]vel|servi[cç]o.{0,30}indispon[ií]vel|indispon[ií]vel.{0,30}moment|tente novamente (mais tarde|em alguns minutos)|sistema (est[aá] )?fora do ar|erro (interno|inesperado) do servidor|falha ao processar/i;
  const DOWNLOAD_TEXT_HINTS = /baixar|salvar|download|imprimir|gerar pdf|visualizar certid[aã]o|visualizar certificado/i;
  /* Seletores confirmados observando o site ao vivo (não uma heurística) —
     tentados depois de um override manual do usuário (que sempre tem
     prioridade) e antes da heurística genérica em resolveElement(). Só
     entram aqui campos onde a heurística já se mostrou não confiável o
     bastante para valer a pena fixar; se o site mudar o HTML no futuro e o
     id ficar obsoleto, o querySelector simplesmente não acha nada e cai de
     volta na heurística normalmente. */
  const KNOWN_SELECTORS = {
    cndt: {
      cnpjInput: '#gerarCertidaoForm\\:cpfCnpj',
    },
    simples: {
      /* O campo espera só dígitos (sem pontuação) — já é assim por padrão,
         já que o CNPJ chega em runFlow() sempre sem máscara
         (CNPJUtil.onlyDigits em background.js, antes de qualquer site). */
      cnpjInput: '#Cnpj',
      /* Depois de "Consultar", o hCaptcha faz o POST de verdade (ver
         processResult() acima) e a página de resultado tem um botão
         "Gerar PDF" com esse id — é o gatilho real de download. */
      downloadTrigger: '#gerarpdf',
    },
  };
  /* Depois de preencher o CNPJ, alguns sites esperam o foco já estar no
     campo de resposta do captcha (ex.: o CNDT do TST expõe o captcha em
     áudio/imagem e o campo de resposta em #idCampoResposta) — sem isso o
     usuário precisa clicar manualmente antes de poder digitar a resposta. */
  const POST_FILL_FOCUS_SELECTOR = {
    cndt: '#idCampoResposta',
  };
  /* Nesses sites o captcha precisa ser resolvido ANTES de clicar no botão
     de emitir/consultar — clicar cedo demais não funciona (o site espera
     o captcha já resolvido) e pode até invalidar o desafio, obrigando a
     resolver de novo. Se um captcha já estiver visível logo depois de
     preencher o CNPJ, a extensão não clica em nada: só avisa o usuário e
     espera ele mesmo resolver e clicar em emitir/consultar. */
  const SUBMIT_REQUIRES_CAPTCHA_FIRST = new Set(['cndt']);
  /* O CNDT (TST) não mostra um PDF na própria página — ele confirma no
     texto que já mandou por e-mail ("Certidão EMITIDA e ENVIADA por e-mail
     com sucesso"). Precisa ser verificado ANTES de RESULT_TEXT_HINTS
     genérico, porque essa frase também contém "certidão emitida" e cairia
     no caminho normal de "procurar botão de baixar", que aqui não existe. */
  const EMAIL_SENT_HINTS = /emitida\s+e\s+enviada\s+por\s+e-?mail|enviad[ao]\s+por\s+e-?mail\s+com\s+sucesso|certid[aã]o\s+ser[aá]\s+enviada\s+por\s+e-?mail/i;

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
    /* input[type="button"] entra aqui de propósito: é assim que o JSF da
       Caixa renderiza os botões ("Consultar", provavelmente "Obter
       Certificado" também) — sem isso a extensão nunca via esses botões,
       porque não é <button> nem input[type="submit"]. */
    const candidates = Array.from(
      document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn, a[role="button"]')
    )
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

  /* document.body.innerText inclui menu, cabeçalho e rodapé — em portais
     como o da Caixa, o próprio link de navegação permanente ("Certificado
     de Regularidade do FGTS - CRF") já bate com o padrão genérico de
     resultado, fazendo a extensão pensar que a consulta terminou quase
     instantaneamente após o clique (confirmado num log real: menos de
     10ms entre o clique e "resultado detectado", tempo insuficiente pra
     qualquer resposta de servidor). Por isso os detectores de captcha/
     resultado/indisponibilidade usam este texto, que exclui cabeçalho,
     navegação, rodapé e qualquer link — o conteúdo de um resultado real
     é sempre texto simples da página, nunca um item de menu clicável. */
  function detectionText() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"], a').forEach((el) => el.remove());
    return clone.innerText || clone.textContent || '';
  }

  function detectResult() {
    const bodyText = detectionText();
    return (
      RESULT_TEXT_HINTS.test(bodyText) ||
      RESULT_BLOCKED_HINTS.test(bodyText) ||
      RESULT_SIMPLES_OPTANTE_HINTS.test(bodyText) ||
      RESULT_CAIXA_IMPEDIMENTO_HINTS.test(bodyText)
    );
  }

  function detectTemporarilyUnavailable() {
    const bodyText = detectionText();
    return TEMP_UNAVAILABLE_HINTS.test(bodyText);
  }

  function detectEmailSent() {
    const bodyText = detectionText();
    return EMAIL_SENT_HINTS.test(bodyText);
  }

  /* Diz qual dos resultados possíveis apareceu — usado só para logar de
     forma legível e para decidir se vale a pena procurar botão de
     emitir/baixar (num estado "bloqueado" não existe PDF nenhum, então
     nem tenta). Não muda o fato de que qualquer uma das três certidões
     "normais" (negativa, positiva, positiva com efeitos de negativa)
     segue o mesmo caminho de download. */
  function classifyResultText() {
    const text = detectionText();
    /* Checa antes de RESULT_BLOCKED_HINTS: é uma resposta definitiva da
       Caixa (não um erro de consulta), então não deve virar status "erro". */
    if (RESULT_CAIXA_IMPEDIMENTO_HINTS.test(text)) return 'impedimento_caixa';
    if (RESULT_BLOCKED_HINTS.test(text)) return 'bloqueado';
    if (RESULT_CERTIDAO_VALIDA_HINTS.test(text)) return 'certidao_valida_existente';
    if (RESULT_POSITIVA_PENDENCIA_HINTS.test(text)) return 'positiva_com_pendencia';
    if (RESULT_POSITIVA_HINTS.test(text)) return 'positiva';
    if (RESULT_NEGATIVA_HINTS.test(text)) return 'negativa';
    if (RESULT_TEXT_HINTS.test(text)) return 'regular';
    /* "não optante" precisa ser testado antes do genérico "optante", já
       que a frase negativa também contém a palavra "optante". */
    if (RESULT_SIMPLES_NAO_OPTANTE_HINTS.test(text)) return 'simples_nao_optante';
    if (RESULT_SIMPLES_OPTANTE_HINTS.test(text)) return 'simples_optante';
    return 'desconhecido';
  }

  function extractMatchSnippet(regex, maxLen = 220) {
    const text = detectionText().replace(/\s+/g, ' ').trim();
    const match = regex.exec(text);
    if (!match) return '';
    const start = Math.max(0, match.index - 20);
    return text.slice(start, start + maxLen).trim();
  }

  /* Só usado no modo de gravação detalhada: diz qual padrão de resultado
     bateu primeiro e um trecho do texto ao redor — pra diagnosticar casos
     como um item de menu permanente batendo com o padrão genérico de
     resultado (já aconteceu: "Certificado de Regularidade do FGTS - CRF"
     no menu da Caixa), sem precisar inferir isso só pelo tempo entre os
     eventos do log. */
  function identifyMatchedResultHint() {
    const text = detectionText();
    const candidates = [
      ['RESULT_CAIXA_IMPEDIMENTO_HINTS', RESULT_CAIXA_IMPEDIMENTO_HINTS],
      ['RESULT_BLOCKED_HINTS', RESULT_BLOCKED_HINTS],
      ['RESULT_CERTIDAO_VALIDA_HINTS', RESULT_CERTIDAO_VALIDA_HINTS],
      ['RESULT_SIMPLES_OPTANTE_HINTS', RESULT_SIMPLES_OPTANTE_HINTS],
      ['RESULT_TEXT_HINTS', RESULT_TEXT_HINTS],
    ];
    for (const [name, pattern] of candidates) {
      if (pattern.test(text)) return { pattern: name, snippet: extractMatchSnippet(pattern) };
    }
    return null;
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

    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn, a[role="button"], a'))
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

    /* Categórico/estrutural (lista fechada de opções, tipo UF), não um
       valor livre digitado — por isso é seguro incluir qual opção estava
       selecionada, diferente do que fazemos com <input> de texto. */
    const selects = Array.from(document.querySelectorAll('select'))
      .filter(isVisible)
      .slice(0, 15)
      .map((el) => ({
        tag: 'select',
        id: el.id || null,
        name: el.name || null,
        formcontrolname: el.getAttribute('formcontrolname'),
        ariaLabel: el.getAttribute('aria-label'),
        options: Array.from(el.options || [])
          .slice(0, 60)
          .map((o) => ({ value: o.value, text: textOf(o) })),
        excludedContext: isInExcludedContext(el),
        selector: elementToSelector(el),
      }));

    return { title: document.title, url: location.href, inputs, buttons, selects };
  }

  /* Setado uma vez no início de runFlow() a partir de storage.local — modo
     de gravação detalhada (Configurações → Log de navegação). Ligado, todo
     recordDebug() passa a incluir o retrato estrutural da página (nunca
     CNPJ nem conteúdo da certidão, só ids/seletores/textos de botão), não
     só os eventos marcados como importantes — pra entender exatamente que
     elementos existiam e por que a extensão tomou cada decisão. */
  let verboseDiagnosticsEnabled = false;

  function recordDebug(siteKey, step, detail, snapshot) {
    const wantsSnapshot = snapshot || verboseDiagnosticsEnabled;
    browser.runtime
      .sendMessage({
        type: 'DEBUG_LOG',
        siteKey,
        step,
        detail,
        snapshot: wantsSnapshot ? snapshotPage() : null,
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
    const known = KNOWN_SELECTORS[siteKey] && KNOWN_SELECTORS[siteKey][kind];
    if (known) {
      const el = document.querySelector(known);
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

  /* Executa os passos extras aprendidos pelo modo de aprendizado (task
     mining) ou calibrados manualmente — coisas que não têm um campo fixo
     próprio, tipo selecionar uma UF ou marcar "aceito os termos". Roda
     depois de preencher o CNPJ e antes de clicar em consultar. Se algum
     elemento configurado sumiu da página, só pula esse passo e loga —
     nunca trava o fluxo por causa disso. */
  async function runExtraSteps(siteKey) {
    const { extraStepOverrides = {} } = await browser.storage.local.get('extraStepOverrides');
    const steps = extraStepOverrides[siteKey];
    if (!steps) return;

    for (const [role, step] of Object.entries(steps)) {
      const el = step?.selector ? document.querySelector(step.selector) : null;
      if (!el || !isVisible(el)) {
        recordDebug(siteKey, 'extra_step_skipped', `"${role}" — elemento não encontrado na página (${step?.selector}).`);
        continue;
      }
      if (step.action === 'select' && step.value != null) {
        setNativeValue(el, step.value);
        recordDebug(siteKey, 'extra_step_done', `"${role}" — selecionou valor "${step.value}" (${step.selector}).`);
      } else if (step.action === 'click') {
        el.click();
        recordDebug(siteKey, 'extra_step_done', `"${role}" — clicou (${step.selector}).`);
        await sleep(300);
      }
    }
  }

  function reportUnavailable(siteKey, overrideDetail) {
    const detail = overrideDetail || extractMatchSnippet(TEMP_UNAVAILABLE_HINTS) || 'Serviço indisponível no momento.';
    recordDebug(siteKey, 'temporarily_unavailable', detail, true);
    sendStatus(siteKey, 'temporarily_unavailable', detail);
  }

  /* O CNDT normalmente gera o PDF na hora, igual RFB/Caixa (pego pelo
     caminho normal de findDownloadTrigger logo abaixo) — o aviso de
     "enviado por e-mail" só aparece quando NÃO existe link de PDF na
     página, então só entra como sucesso alternativo nesse caso, nunca
     no lugar da busca normal por um trigger de download. */
  function checkEmailSentFallback(siteKey) {
    if (!detectEmailSent()) return false;
    const detail = extractMatchSnippet(EMAIL_SENT_HINTS) || 'Certidão emitida e enviada por e-mail.';
    recordDebug(siteKey, 'emailed', detail, true);
    sendStatus(siteKey, 'emailed', detail);
    return true;
  }

  function findRadioByLabelText(pattern) {
    const labels = Array.from(document.querySelectorAll('label'));
    const target = labels.find((l) => pattern.test(textOf(l)));
    if (!target) return null;
    if (target.htmlFor) {
      const el = document.getElementById(target.htmlFor);
      if (el) return el;
    }
    return target.closest('div, mat-radio-button, .form-group')?.querySelector('input[type="radio"]') || null;
  }

  /* RFB: na tela "Certidão Válida Encontrada", clica em "Consultar" (não
     em "Emitir Nova Certidão"), escolhe a opção "data de validade" e
     preenche o período de hoje até 90 dias à frente, depois clica em
     "Consultar Certidão" — só então a certidão de verdade aparece pra
     download, seguindo o fluxo normal do resto de processResult(). */
  async function handleRfbExistingCertidaoFlow(siteKey) {
    const consultarBtn = await waitFor(() => findButtonHeuristic([/^consultar$/i, /consultar/i]), { timeout: 8000, interval: 300 });
    if (!consultarBtn) {
      recordDebug(siteKey, 'certidao_valida_consultar_missing', 'Botão "Consultar" não encontrado na tela de certidão já existente.', true);
      return false;
    }
    recordDebug(siteKey, 'certidao_valida_consultar_click', `"${textOf(consultarBtn)}" (${elementToSelector(consultarBtn)})`);
    consultarBtn.click();

    const radio = await waitFor(() => findRadioByLabelText(/data\s+de\s+validade/i), { timeout: 15000, interval: 400 });
    if (!radio) {
      recordDebug(siteKey, 'certidao_valida_radio_missing', 'Opção "data de validade" não encontrada.', true);
      return false;
    }
    radio.click();
    recordDebug(siteKey, 'certidao_valida_radio_selected', elementToSelector(radio));
    await sleep(300);

    const dataInicialInput = await waitFor(() => document.querySelector('input[name="dataInicial"]'), { timeout: 8000, interval: 300 });
    const dataFinalInput = document.querySelector('input[name="dataFinal"]');
    if (!dataInicialInput || !dataFinalInput) {
      recordDebug(siteKey, 'certidao_valida_datas_missing', 'Campos de data inicial/final não encontrados.', true);
      return false;
    }

    const fmt = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    const today = new Date();
    const in90Days = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000);
    setNativeValue(dataInicialInput, fmt(today));
    setNativeValue(dataFinalInput, fmt(in90Days));
    recordDebug(siteKey, 'certidao_valida_datas_preenchidas', `${fmt(today)} a ${fmt(in90Days)}`);
    await sleep(300);

    const consultarCertidaoBtn = await waitFor(() => findButtonHeuristic([/consultar\s+certid[aã]o/i]), { timeout: 8000, interval: 300 });
    if (!consultarCertidaoBtn) {
      recordDebug(siteKey, 'certidao_valida_consultar_certidao_missing', 'Botão "Consultar Certidão" não encontrado.', true);
      return false;
    }
    consultarCertidaoBtn.click();
    recordDebug(siteKey, 'certidao_valida_consultar_certidao_click', `"${textOf(consultarCertidaoBtn)}"`);
    await sleep(500);
    return true;
  }

  /* Processa a página assim que ela mostra um resultado — usado tanto no
     fluxo normal (depois do submit) quanto quando o content script já
     inicia com o resultado na tela: alguns sites (ex.: Simples Nacional)
     fazem um POST de formulário de verdade em vez de atualização via ajax,
     recarregando a página inteira e reinjetando o content script do zero
     numa página que não tem mais o formulário de CNPJ — nesse caso não dá
     pra "preencher de novo", só processar o que já está visível. */
  async function processResult(siteKey, cnpj, selectorOverrides) {
    recordDebug(siteKey, 'result_detected', `URL: ${location.href}`);
    if (verboseDiagnosticsEnabled) {
      const matched = identifyMatchedResultHint();
      if (matched) recordDebug(siteKey, 'result_match_detail', `padrão=${matched.pattern} trecho="${matched.snippet}"`, true);
    }

    /* Alguns estados são definitivos e não vão gerar PDF nenhum (CNPJ
       inválido, empregador não cadastrado no FGTS, etc.) — reporta como
       erro dessa certidão específica e nem tenta procurar botão de
       emitir/baixar, que não existirá. */
    const classification = classifyResultText();
    if (classification === 'bloqueado') {
      const detail = extractMatchSnippet(RESULT_BLOCKED_HINTS) || 'O site indicou que não é possível emitir a certidão para este CNPJ agora.';
      recordDebug(siteKey, 'result_blocked', detail, true);
      sendStatus(siteKey, 'error', detail);
      return;
    }

    /* Resposta definitiva de que não há certificado a emitir (ex.: Caixa
       reportando impedimentos no FGTS) — o processo terminou, só não gerou
       PDF nenhum pra baixar. Não é um erro: salva a tela que já mostra a
       resposta, do mesmo jeito que quando nenhum site oferece um trigger
       de download, sem gastar tempo procurando botões que não existem. */
    if (classification === 'impedimento_caixa') {
      const detail = extractMatchSnippet(RESULT_CAIXA_IMPEDIMENTO_HINTS) || RESULT_CLASSIFICATION_LABEL.impedimento_caixa;
      recordDebug(siteKey, 'result_impedimento', detail, true);
      sendStatus(siteKey, 'result_ready', RESULT_CLASSIFICATION_LABEL.impedimento_caixa);
      /* Status próprio (não o "manual_save_needed" genérico): o processo
         terminou, mas não existe certidão nenhuma pra extrair — só a tela
         com o aviso. O popup usa isso pra colorir esse caso diferente de
         um sucesso normal (ver 'no_certificate' em succeedJob). */
      sendStatus(siteKey, 'concluded_without_certificate', detail);
      return;
    }

    /* Não retorna aqui: depois de completar esse sub-fluxo, a certidão de
       verdade deve estar na tela, e o resto de processResult (procurar o
       trigger de download etc.) segue normalmente. */
    if (classification === 'certidao_valida_existente') {
      recordDebug(siteKey, 'certidao_valida_encontrada', 'Certidão válida já existente — seguindo Consultar → data de validade → Consultar Certidão.', true);
      const handled = await handleRfbExistingCertidaoFlow(siteKey);
      if (!handled) {
        sendStatus(siteKey, 'error', 'Certidão válida já existente, mas não foi possível seguir o fluxo de consulta por data de validade. Verifique a página ou ajuste os seletores.');
        return;
      }
    }

    sendStatus(siteKey, 'result_ready', RESULT_CLASSIFICATION_LABEL[classification] || null);

    /* O Gemini Nano (quando disponível, só no Chrome) lê o texto visível
       da página e classifica se a certidão saiu regular, com pendências,
       ou se o "resultado" é na real uma falha temporária do site — isso
       complementa a heurística de regex, que só reconhece frases exatas. */
    const resultVerdict = typeof classifyPageWithAI === 'function' ? await classifyPageWithAI(siteKey) : null;
    if (resultVerdict) {
      if (resultVerdict.status === 'indisponivel_temporario') {
        reportUnavailable(siteKey, resultVerdict.resumo);
        return;
      }
      sendStatus(siteKey, 'ai_verdict', resultVerdict);
    }
    await sleep(500);

    /* Alguns desses portais mostram a "situação" numa primeira consulta e
       só geram o PDF depois de um ou mais cliques extras — a Caixa, por
       exemplo, usa um botão "Visualizar" nessa etapa, e pode ter mais de
       uma confirmação em sequência. Repete a busca por um botão de
       emitir/obter/visualizar/confirmar até achar um jeito de baixar ou
       esgotar as tentativas, em vez de assumir que é sempre um clique só. */
    const MAX_EMIT_STEPS = 3;
    for (let step = 0; step < MAX_EMIT_STEPS; step++) {
      if (findDownloadTrigger()) break;
      const emitBtn = resolveElement('emitButton', siteKey, selectorOverrides, () => findButtonHeuristic([EMIT_STEP_TEXT_HINTS]));
      if (!emitBtn || !isVisible(emitBtn) || emitBtn.disabled) break;
      recordDebug(siteKey, 'emit_button_found', `"${textOf(emitBtn)}" (${elementToSelector(emitBtn)}) [passo ${step + 1}/${MAX_EMIT_STEPS}]`);
      sendStatus(siteKey, 'emitting');
      emitBtn.click();
      await waitFor(
        () => findDownloadTrigger() || resolveElement('emitButton', siteKey, selectorOverrides, () => findButtonHeuristic([EMIT_STEP_TEXT_HINTS])),
        { timeout: 20000, interval: 500 }
      );
    }

    const trigger = resolveElement('downloadTrigger', siteKey, selectorOverrides, findDownloadTrigger);
    if (!trigger) {
      if (checkEmailSentFallback(siteKey)) return;
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

    if (checkEmailSentFallback(siteKey)) return;
    sendStatus(siteKey, 'manual_save_needed');
  }

  /* Fluxo genérico reaproveitado pelos sites automatizados: preenche o
     CNPJ, envia o formulário, aguarda captcha (se aparecer) e resultado, e
     então localiza um jeito de salvar o PDF — link direto (download
     silencioso) ou botão de imprimir/baixar (fallback pedindo 1 clique ao
     usuário via background). */
  async function runFlow(siteKey, cnpj) {
    try {
      const { selectorOverrides = {}, verboseDiagnostics } = await browser.storage.local.get(['selectorOverrides', 'verboseDiagnostics']);
      verboseDiagnosticsEnabled = !!verboseDiagnostics;
      recordDebug(siteKey, 'start', `URL: ${location.href}`, true);

      /* Alguns sites (ex.: Simples Nacional) fazem um POST de formulário de
         verdade em vez de atualização via ajax — o que reinjeta o content
         script do zero numa página que já mostra o resultado, sem mais o
         formulário. Detecta esse caso ANTES de procurar o campo de CNPJ —
         mas só quando o campo realmente não existe mais: várias páginas
         iniciais (ex.: a da Caixa) têm texto explicativo tipo "Certificado
         de Regularidade do FGTS" na descrição do serviço, o que bateria com
         RESULT_TEXT_HINTS mesmo sem nenhuma consulta ter sido feita ainda.
         Exigir a ausência do campo de CNPJ evita esse falso positivo. */
      const cnpjAlreadyMissing = !resolveElement('cnpjInput', siteKey, selectorOverrides, findCnpjInputHeuristic);
      if (cnpjAlreadyMissing && detectTemporarilyUnavailable()) {
        reportUnavailable(siteKey);
        return;
      }
      if (cnpjAlreadyMissing && detectResult()) {
        recordDebug(siteKey, 'result_already_present', 'Resultado já visível ao iniciar, sem campo de CNPJ (provável reinjeção após navegação de formulário).');
        await processResult(siteKey, cnpj, selectorOverrides);
        return;
      }

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
      await runExtraSteps(siteKey);

      const focusSelector = POST_FILL_FOCUS_SELECTOR[siteKey];
      if (focusSelector) {
        const focusTarget = document.querySelector(focusSelector);
        if (focusTarget && isVisible(focusTarget)) {
          focusTarget.focus();
          recordDebug(siteKey, 'post_fill_focus', `Foco movido para ${focusSelector}.`);
        }
      }

      /* Espera um pouco pelo widget do captcha renderizar (alguns carregam
         de forma assíncrona, um instante depois do resto da página) antes
         de decidir se ele já está presente. */
      const captchaAlreadyPresent =
        SUBMIT_REQUIRES_CAPTCHA_FIRST.has(siteKey) &&
        (await waitFor(() => detectCaptcha().present || null, { timeout: 5000, interval: 300 }));

      if (captchaAlreadyPresent) {
        recordDebug(siteKey, 'captcha_before_submit', 'Captcha detectado antes do envio — aguardando o usuário resolver e clicar em emitir/consultar manualmente.');
        sendStatus(siteKey, 'captcha');
        const outcome = await waitFor(() => {
          if (detectTemporarilyUnavailable()) return { type: 'unavailable' };
          if (detectResult()) return { type: 'result' };
          return null;
        }, { timeout: 300000, interval: 400 });
        if (!outcome) {
          recordDebug(siteKey, 'captcha_timeout', 'Resultado não apareceu após a resolução do captcha e o envio manual (5 min).', true);
          sendStatus(siteKey, 'error', 'Tempo esgotado aguardando a resolução do captcha e o envio.');
          return;
        }
        if (outcome.type === 'unavailable') {
          reportUnavailable(siteKey);
          return;
        }
        await processResult(siteKey, cnpj, selectorOverrides);
        return;
      }

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
      const submittedAt = Date.now();

      async function waitForOutcome(timeoutMs) {
        return waitFor(() => {
          if (detectCaptcha().present) return { type: 'captcha' };
          if (detectTemporarilyUnavailable()) return { type: 'unavailable' };
          if (detectResult()) return { type: 'result' };
          return null;
        }, { timeout: timeoutMs, interval: 400 });
      }

      let outcome = await waitForOutcome(15000);
      if (verboseDiagnosticsEnabled && outcome) {
        const matched = outcome.type === 'result' ? identifyMatchedResultHint() : null;
        recordDebug(
          siteKey,
          'outcome_timing',
          `tipo=${outcome.type} ${Date.now() - submittedAt}ms após o clique em consultar/emitir` +
            (matched ? ` — padrão=${matched.pattern} trecho="${matched.snippet}"` : ''),
          true
        );
      }

      if (outcome && outcome.type === 'captcha') {
        recordDebug(siteKey, 'captcha_detected', 'Captcha visível após o envio.');
        sendStatus(siteKey, 'captcha');
        /* Alguns sites (ex.: hCaptcha "invisível") fazem um POST de
           formulário de verdade assim que o captcha é resolvido — a
           navegação destrói esta execução no meio do caminho, sem erro
           algum, e o content script reinjeta do zero na página de
           resultado (pego pelo checkpoint de "resultado já visível" no
           início de runFlow). Não há nada a fazer aqui além de aguardar
           normalmente; se a página não navegar, o polling abaixo resolve. */
        outcome = await waitForOutcome(300000);
        if (!outcome) {
          recordDebug(siteKey, 'captcha_timeout', 'Resultado não apareceu após resolução do captcha (5 min).', true);
          sendStatus(siteKey, 'error', 'Tempo esgotado aguardando a resolução do captcha.');
          return;
        }
      }

      if (outcome && outcome.type === 'unavailable') {
        reportUnavailable(siteKey);
        return;
      }

      if (!outcome) {
        const verdict = typeof classifyPageWithAI === 'function' ? await classifyPageWithAI(siteKey) : null;
        if (verdict && verdict.status === 'indisponivel_temporario') {
          reportUnavailable(siteKey, verdict.resumo);
          return;
        }
        recordDebug(siteKey, 'result_missing', 'Nenhum texto de resultado reconhecido após o envio.', true);
        sendStatus(siteKey, 'error', verdict?.resumo || 'A página não retornou um resultado reconhecível. Verifique o CNPJ ou ajuste os seletores.');
        return;
      }

      await processResult(siteKey, cnpj, selectorOverrides);
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
    detectTemporarilyUnavailable,
    detectEmailSent,
    classifyResultText,
    extractMatchSnippet,
    findDownloadTrigger,
    elementToSelector,
    resolveElement,
    fetchAsBase64,
    enablePickerMode,
    runFlow,
    runExtraSteps,
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
