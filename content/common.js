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
  /* Caixa: "Obtenha o Certificado de Regularidade do FGTS - CRF" é o sinal
     real de que há certificado pra pegar — mas o trecho "Certificado de
     Regularidade do FGTS - CRF" fica dentro de um <a> (é clicável), e
     detectionText() exclui todo <a> do texto (pra não confundir com o
     link permanente do menu, que causava falso positivo de resultado
     quase instantâneo — ver RESULT_TEXT_HINTS acima). Isso apagava
     também esse sinal legítimo, fazendo a extensão não reconhecer um
     resultado que na verdade existia (confirmado por um usuário: a tela
     mostrava exatamente essa frase, mas a extensão dizia "nenhum
     resultado reconhecido"). Por isso esse padrão específico é checado
     contra o texto CRU da página (document.body.innerText), não contra
     detectionText() — só ele tem esse tratamento especial, porque só ele
     depende do texto de dentro de um link pra ser reconhecido. */
  const RESULT_CAIXA_OBTENHA_HINTS = /obtenha\s+o\s+certificado\s+de\s+regularidade\s+do\s+fgts/i;
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
  /* Heurística pra achar a IMAGEM do captcha (não o widget genérico de
     reCAPTCHA/hCaptcha, que detectCaptcha() já cobre) — usada só quando a
     resolução automática por IA está ligada (ver tryAutoSolveCaptcha). Um
     <img> com esses termos no src/alt/id/class costuma ser o desafio
     visual em si, não uma logo ou ícone decorativo. */
  const CAPTCHA_IMAGE_HINTS = /captcha|imagem.{0,15}verifica|c[oó]digo.{0,10}imagem|desafio/i;
  /* Usado para excluir, de qualquer clique automático, uma opção de
     "enviar por e-mail" quando o fluxo oferecer escolha de entrega — ver
     findButtonHeuristic(). */
  const EMAIL_OPTION_HINTS = /e-?mail/i;

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
      .filter((el) => !isInExcludedContext(el))
      /* Nenhum dos nossos padrões de emitir/consultar/baixar deveria
         legitimamente casar com um botão que fale em "e-mail" — quando
         isso acontece, é quase sempre a opção "enviar por e-mail" de um
         fluxo com escolha de entrega, e a extensão nunca deve escolher
         essa opção sozinha (pedido explícito do usuário: preferir sempre
         o caminho que baixa/mostra a certidão direto). */
      .filter((el) => !EMAIL_OPTION_HINTS.test(textOf(el)));

    for (const pattern of patterns) {
      const match = candidates.find((el) => pattern.test(textOf(el)));
      if (match) return match;
    }
    return null;
  }

  function detectCaptcha() {
    /* Bug real confirmado por um usuário (RFB avisou "resolva o captcha"
       sem nenhum captcha pra resolver): faltavam parênteses aqui — o jeito
       antigo testava CAPTCHA_HINTS.test(f.title) mesmo quando o iframe
       estava invisível, porque && tem precedência maior que ||. O selo do
       reCAPTCHA (sempre presente numa página protegida, mas sem exigir
       nenhuma ação do usuário na maioria dos casos) costuma ter um iframe
       com title="reCAPTCHA" mesmo quando escondido via CSS — batia com o
       padrão e disparava o aviso à toa. Agora as duas condições exigem
       visibilidade. */
    const iframe = Array.from(document.querySelectorAll('iframe')).find(
      (f) => isVisible(f) && (CAPTCHA_HINTS.test(f.src || '') || CAPTCHA_HINTS.test(f.title || ''))
    );
    if (iframe) return { present: true, el: iframe };

    const widget = Array.from(document.querySelectorAll('div, section')).find(
      (el) => isVisible(el) && Array.from(el.classList).some((c) => CAPTCHA_HINTS.test(c))
    );
    if (widget) return { present: true, el: widget };

    return { present: false, el: null };
  }

  /* Acha a imagem do captcha próprio do site (não um widget de terceiro —
     esses já são cobertos por detectCaptcha()). Tenta primeiro por
     src/alt/id/class que sugira captcha; se nada bater, procura o <img>
     visível mais próximo do campo de resposta conhecido do site (subindo
     pela árvore do DOM), já que nesses portais a imagem normalmente fica
     ao lado do campo onde a resposta é digitada. Retorna null (não
     arrisca um palpite, tipo a primeira imagem da página) se nenhuma das
     duas estratégias achar nada — quem chama trata isso como "não dá pra
     tentar resolver automaticamente" e cai no fluxo manual. */
  function findCaptchaImageHeuristic(siteKey) {
    const images = Array.from(document.querySelectorAll('img')).filter(isVisible);
    const byHint = images.find(
      (img) =>
        CAPTCHA_IMAGE_HINTS.test(img.src || '') ||
        CAPTCHA_IMAGE_HINTS.test(img.alt || '') ||
        CAPTCHA_IMAGE_HINTS.test(img.id || '') ||
        CAPTCHA_IMAGE_HINTS.test(img.className || '')
    );
    if (byHint) return byHint;

    const answerSelector = POST_FILL_FOCUS_SELECTOR[siteKey];
    const answerField = answerSelector && document.querySelector(answerSelector);
    if (!answerField) return null;
    let node = answerField;
    for (let i = 0; i < 6 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const img = Array.from(node.querySelectorAll('img')).filter(isVisible)[0];
      if (img) return img;
    }
    return null;
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
    /* script/style/noscript nunca deveriam aparecer em texto visível — mas
       o clone é um nó DESANEXADO do documento, e .innerText (que respeita
       display:none) pode não funcionar corretamente em nós desanexados
       em alguns navegadores, caindo no fallback .textContent, que NÃO
       respeita CSS/rendering e inclui o conteúdo de <script> igual a
       qualquer outro texto. Bug real confirmado por um usuário: o texto
       capturado como "temporariamente indisponível" era na verdade
       código JavaScript da própria página ($('#GerarPDF').click(...)),
       fazendo a extensão achar que o site estava fora do ar quando na
       verdade o resultado (botão "Gerar PDF") já estava disponível. */
    clone.querySelectorAll('header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"], a, script, style, noscript').forEach((el) => el.remove());
    return clone.innerText || clone.textContent || '';
  }

  function detectResult() {
    const bodyText = detectionText();
    return (
      RESULT_TEXT_HINTS.test(bodyText) ||
      RESULT_BLOCKED_HINTS.test(bodyText) ||
      RESULT_SIMPLES_OPTANTE_HINTS.test(bodyText) ||
      RESULT_CAIXA_IMPEDIMENTO_HINTS.test(bodyText) ||
      RESULT_CAIXA_OBTENHA_HINTS.test(document.body.innerText || '')
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
    /* Checado contra o texto cru (não detectionText()) pelo mesmo motivo
       de detectResult() acima — ver comentário em RESULT_CAIXA_OBTENHA_HINTS. */
    if (RESULT_CAIXA_OBTENHA_HINTS.test(document.body.innerText || '')) return 'regular';
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

  /* Retorna a label E o input de rádio associado — clicar só no input pode
     não bastar em componentes customizados (comuns nesses design systems
     de governo), onde o clique de verdade é tratado por um listener na
     label/wrapper visível, não no input nativo escondido por trás. */
  function findRadioByLabelText(pattern) {
    const labels = Array.from(document.querySelectorAll('label'));
    const target = labels.find((l) => pattern.test(textOf(l)));
    if (!target) return null;
    let radio = target.htmlFor ? document.getElementById(target.htmlFor) : null;
    if (!radio || radio.type !== 'radio') {
      radio = target.closest('div, mat-radio-button, .form-group')?.querySelector('input[type="radio"]') || null;
    }
    return radio ? { label: target, radio } : null;
  }

  const EMITIR_NOVA_HINTS = /emitir\s+nova\s+certid[aã]o/i;

  /* RFB: na tela "Certidão Válida Encontrada", clica direto em "Emitir Nova
     Certidão" — usado quando o usuário desativou o reaproveitamento de
     certidão existente, ou quando a(s) já existente(s) não atendem à
     validade mínima configurada. */
  async function handleRfbEmitNovaCertidao(siteKey) {
    const btn = await waitFor(() => findButtonHeuristic([EMITIR_NOVA_HINTS]), { timeout: 8000, interval: 300 });
    if (!btn) {
      recordDebug(siteKey, 'emitir_nova_certidao_missing', 'Botão "Emitir Nova Certidão" não encontrado.', true);
      return false;
    }
    recordDebug(siteKey, 'emitir_nova_certidao_click', `"${textOf(btn)}" (${elementToSelector(btn)})`);
    btn.click();
    await sleep(500);
    return true;
  }

  /* RFB: na tela "Certidão Válida Encontrada", clica em "Consultar" (não
     em "Emitir Nova Certidão"), escolhe a opção "data de validade" e
     preenche o período de hoje até 90 dias à frente, depois clica em
     "Consultar Certidão" — só então a certidão de verdade aparece pra
     download, seguindo o fluxo normal do resto de processResult(). Repassa
     minDays para handleRfbCertidoesListFlow decidir se a certidão achada
     na lista tem validade suficiente pra valer a pena reaproveitar. */
  async function handleRfbExistingCertidaoFlow(siteKey, minDays) {
    const consultarBtn = await waitFor(() => findButtonHeuristic([/^consultar$/i, /consultar/i]), { timeout: 8000, interval: 300 });
    if (!consultarBtn) {
      recordDebug(siteKey, 'certidao_valida_consultar_missing', 'Botão "Consultar" não encontrado na tela de certidão já existente.', true);
      return false;
    }
    recordDebug(siteKey, 'certidao_valida_consultar_click', `"${textOf(consultarBtn)}" (${elementToSelector(consultarBtn)})`);
    consultarBtn.click();

    const radioMatch = await waitFor(() => findRadioByLabelText(/data\s+de\s+validade/i), { timeout: 15000, interval: 400 });
    if (!radioMatch) {
      recordDebug(siteKey, 'certidao_valida_radio_missing', 'Opção "data de validade" não encontrada.', true);
      return false;
    }
    const { label, radio } = radioMatch;
    /* Clica na label primeiro — é nela que um usuário real clica, e é ela
       que costuma disparar o efeito completo (revelar os campos
       condicionais) em componentes customizados. Clicar só no input pode
       marcá-lo como "checked" sem disparar esse efeito — confirmado na
       prática: manualmente os campos aparecem juntos com a tela, mas a
       automação não os revelava mesmo com o rádio marcado. */
    label.click();
    if (!radio.checked) radio.click();
    recordDebug(siteKey, 'certidao_valida_radio_selected', `${elementToSelector(radio)} (checked=${radio.checked})`, true);
    await sleep(300);

    /* Testando manualmente, esses campos aparecem em poucos segundos,
       junto com o resto da tela — não é demora do servidor. Já testado:
       clique na label (não só no input) pra revelar os campos condicionais
       — mesmo assim, em log real, os campos aparecem no retrato final da
       página (que também exige isVisible) sem nunca terem sido pegos
       durante os 30s de tentativas. Pra descobrir o motivo real em vez de
       chutar de novo, registra periodicamente o estado bruto (dimensões,
       display/visibility/opacity) dos candidatos, com ou sem filtro de
       visibilidade, junto com a resposta final. */
    /* Achado pelo diagnóstico: input[type="text"] é um seletor CSS que
       exige o ATRIBUTO type="text" literal no HTML — se o Angular renderiza
       o campo sem esse atributo (contando com o padrão do navegador, que
       já é "text"), esse seletor nunca bate, não importa quanto tempo se
       espere. snapshotPage() nunca teve esse problema porque não filtra
       por type nenhum, só lê a propriedade .type (que reflete o padrão
       corretamente) — por isso ele sempre "via" os campos e essa busca
       nunca via. Corrigido pegando todo <input> e checando `.type` (a
       propriedade, não o atributo) em vez do seletor CSS. */
    function findDateCandidates() {
      return Array.from(document.querySelectorAll('input'))
        .filter((el) => el.type === 'text')
        .filter((el) => /selecione a data/i.test(el.getAttribute('placeholder') || ''));
    }

    let lastDiagnosticAt = 0;
    function diagnoseDateFieldCandidates() {
      const all = findDateCandidates();
      if (!all.length) return 'nenhum input com placeholder "Selecione a data" no DOM';
      return all
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return `id=${el.id || '(sem id)'} name=${el.getAttribute('name') || '(sem name)'} rect=${Math.round(rect.width)}x${Math.round(rect.height)} display=${style.display} visibility=${style.visibility} opacity=${style.opacity} isVisible=${isVisible(el)}`;
        })
        .join(' | ');
    }

    const dateFields = await waitFor(() => {
      if (Date.now() - lastDiagnosticAt > 3000) {
        lastDiagnosticAt = Date.now();
        recordDebug(siteKey, 'certidao_valida_datas_diagnostico', diagnoseDateFieldCandidates());
      }
      const candidates = findDateCandidates().filter((el) => isVisible(el));
      if (candidates.length < 2) return null;
      const finalIndex = candidates.findIndex((el) => el.getAttribute('name') === 'dataFinal');
      const final = finalIndex >= 0 ? candidates[finalIndex] : candidates[candidates.length - 1];
      /* Usa a posição do dataFinal como referência: o campo de data
         inicial é o candidato logo antes dele entre os que têm esse
         placeholder — mais preciso do que "qualquer outro", caso a tela
         tenha mais de dois campos parecidos. */
      const initial = finalIndex > 0 ? candidates[finalIndex - 1] : candidates.find((el) => el !== final);
      return initial && final ? { initial, final } : null;
    }, { timeout: 30000, interval: 300 });
    if (!dateFields) {
      recordDebug(siteKey, 'certidao_valida_datas_missing', `Não achou os dois campos de data. Estado final: ${diagnoseDateFieldCandidates()}`, true);
      return false;
    }
    const { initial: dataInicialInput, final: dataFinalInput } = dateFields;

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

    return handleRfbCertidoesListFlow(siteKey, minDays);
  }

  /* Caixa: depois do resultado da consulta, a certidão de verdade só fica
     acessível clicando num link cujo texto é "Certificado de Regularidade
     do FGTS - CRF" — um <a> puro, sem classe .btn nem role="button", por
     isso não é achado por findButtonHeuristic (que só aceita a.btn e
     a[role="button"] entre os links). O mesmo texto também aparece como
     item fixo do menu superior do site, o que já obrigou detectionText()
     a excluir todo <a> da detecção de RESULTADO (ver comentário acima de
     RESULT_TEXT_HINTS) — mas aqui é intencional: procuramos e clicamos
     nesse link de propósito, é assim que se chega à tela realmente
     imprimível. A Caixa só renderiza esse link quando existe certificado
     a emitir para o CNPJ consultado; se não existir, não há nada para
     imprimir. */
  const CAIXA_CRF_LINK_HINTS = /certificado\s+de\s+regularidade\s+do\s+fgts\s*-?\s*crf/i;

  async function handleCaixaCrfLink(siteKey) {
    const link = await waitFor(() => {
      const links = Array.from(document.querySelectorAll('a')).filter(isVisible);
      return links.find((el) => CAIXA_CRF_LINK_HINTS.test(textOf(el))) || null;
    }, { timeout: 8000, interval: 300 });
    if (!link) return false;
    recordDebug(siteKey, 'caixa_crf_link_click', `"${textOf(link)}" (${elementToSelector(link)})`);
    link.click();
    await sleep(500);
    return true;
  }

  const CERTIDOES_LIST_HINTS = /rela[cç][aã]o\s+das\s+certid[oõ]es\s+emitidas\s+por\s+data\s+de\s+validade/i;
  const SEGUNDA_VIA_HINTS = /segunda\s*via|2\s*[ªa]\s*via/i;
  const VALIDA_STATUS_HINTS = /\bv[aá]lida\b/i;
  /* Duas variantes de propósito — nunca reaproveitar a mesma instância com
     flag /g entre .test() e matchAll(): um regex global mantém lastIndex
     entre chamadas de .test(), e reusar o MESMO objeto pra checar strings
     diferentes faz ele "lembrar" uma posição da string anterior, dando
     falso-negativo de forma imprevisível (bug real encontrado em log: a
     linha era achada, mas a extração de data falhava do nada). Por isso
     a checagem booleana usa uma versão SEM /g, e só a extração via
     matchAll (que não sofre desse problema) usa a versão global. */
  const BR_DATE_TEST = /\d{2}\/\d{2}\/\d{4}/;
  const BR_DATE_PATTERN = /(\d{2})\/(\d{2})\/(\d{4})/g;
  /* "Data - Hora de Emissão" tem horário junto (a de validade, não) — usa
     isso pra distinguir qual data da linha é a emissão: a que tiver um
     horário colado é a emissão; a(s) sem horário são candidatas a data de
     validade. Cada chamada usa uma instância nova (evita o mesmo problema
     de lastIndex do BR_DATE_PATTERN global reaproveitado). */
  const BR_DATETIME_PATTERN = /(\d{2})\/(\d{2})\/(\d{4})\s*[-–]?\s*(\d{2}):(\d{2})(?::(\d{2}))?/g;

  /* "Consultar Certidão" (com data de validade) devolve uma LISTA de
     certidões já emitidas nesse período, não a certidão direto — cada
     linha tem uma situação (válida/inválida) e um botão "Segunda Via" que
     gera o PDF daquela certidão específica. Escolhe a linha com situação
     "válida" e a data de validade mais distante (a que fica valendo por
     mais tempo), clica em "Segunda Via" dela, e deixa o resto de
     processResult() (busca normal de download) assumir a partir daí —
     sem isso, a extensão caía no fallback de salvar a lista inteira em
     PDF, o que não é a certidão de verdade. */
  /* Acha o menor elemento que contém tanto "válida" quanto uma data — não
     assume que a "linha" é necessariamente um <tr> (a RFB pode usar
     divs/list items em vez de tabela HTML de verdade). Sobe da ocorrência
     de "válida" procurando um ancestral que também contenha uma data,
     preferindo o menor (mais específico) possível. */
  function findRowLikeCandidates() {
    const validaNodes = Array.from(document.querySelectorAll('body *')).filter((el) => {
      if (el.children.length > 0 && Array.from(el.children).some((c) => VALIDA_STATUS_HINTS.test(textOf(c)))) return false;
      return VALIDA_STATUS_HINTS.test(textOf(el));
    });
    const candidates = new Set();
    for (const node of validaNodes) {
      let ancestor = node;
      for (let depth = 0; ancestor && depth < 6; depth++) {
        if (BR_DATE_TEST.test(textOf(ancestor))) {
          candidates.add(ancestor);
          break;
        }
        ancestor = ancestor.parentElement;
      }
    }
    /* Entre os candidatos (podem ser aninhados uns nos outros), fica só
       com os mais específicos — descarta qualquer um que seja ancestral
       de outro candidato já coletado. */
    const list = Array.from(candidates);
    return list.filter((el) => !list.some((other) => other !== el && el.contains(other)));
  }

  async function handleRfbCertidoesListFlow(siteKey, minDays) {
    const found = await waitFor(() => (CERTIDOES_LIST_HINTS.test(document.body.innerText || '') ? true : null), {
      timeout: 15000,
      interval: 400,
    });
    if (!found) {
      recordDebug(siteKey, 'certidoes_lista_missing', 'Tela "Relação das certidões emitidas por data de validade" não detectada — seguindo fluxo normal mesmo assim.', true);
      return true;
    }

    /* Espera as linhas aparecerem (podem renderizar um instante depois do
       cabeçalho da lista) em vez de checar só uma vez. */
    const rows = await waitFor(() => {
      const found2 = findRowLikeCandidates();
      return found2.length ? found2 : null;
    }, { timeout: 15000, interval: 400 }) || [];
    if (!rows.length) {
      const diag = Array.from(document.querySelectorAll('body *'))
        .filter((el) => el.children.length === 0 && VALIDA_STATUS_HINTS.test(textOf(el)))
        .slice(0, 10)
        .map((el) => `<${el.tagName.toLowerCase()}> "${textOf(el).slice(0, 60)}" (${elementToSelector(el)})`)
        .join(' | ');
      recordDebug(
        siteKey,
        'certidoes_lista_rows_missing',
        `Nenhuma linha com situação "válida" e data encontrada. Ocorrências soltas de "válida": ${diag || 'nenhuma'}`,
        true
      );
      return false;
    }

    /* Pra cada linha candidata, extrai a data de validade (a maior data
       "pura", sem horário) e a data-hora de emissão (a que tiver horário
       colado — "Data - Hora de Emissão" tem hora, a de validade não). */
    const candidates = rows
      .map((row) => {
        const text = textOf(row);
        const plainDates = Array.from(text.matchAll(BR_DATE_PATTERN)).map((m) => new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
        const dateTimes = Array.from(text.matchAll(BR_DATETIME_PATTERN)).map(
          (m) => new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] || 0))
        );
        if (!plainDates.length) return null;
        return {
          row,
          validityDate: new Date(Math.max(...plainDates.map((d) => d.getTime()))),
          emittedAt: dateTimes.length ? new Date(Math.max(...dateTimes.map((d) => d.getTime()))) : null,
        };
      })
      .filter(Boolean);
    if (!candidates.length) {
      recordDebug(siteKey, 'certidoes_lista_data_missing', 'Não conseguiu extrair datas das linhas válidas encontradas.', true);
      return false;
    }

    /* Só reaproveita certidões cuja validade restante atenda ao mínimo
       configurado pelo usuário (Configurações ou popup) — evita pegar uma
       que já está prestes a vencer. Entre as que atendem, se houver mais
       de uma, escolhe a de emissão mais recente (não a de validade mais
       distante) — uma certidão mais nova é preferível mesmo que uma mais
       antiga, por coincidência, valha por mais tempo. */
    const today = new Date();
    const minValidDate = new Date(today.getTime() + (minDays || 0) * 24 * 60 * 60 * 1000);
    const qualifying = candidates.filter((c) => c.validityDate >= minValidDate);
    if (!qualifying.length) {
      const bestAmongAll = candidates.reduce((a, b) => (b.validityDate > a.validityDate ? b : a));
      recordDebug(
        siteKey,
        'certidoes_validade_insuficiente',
        `Melhor certidão válida até ${bestAmongAll.validityDate.toLocaleDateString('pt-BR')} — abaixo do mínimo configurado de ${minDays} dias (precisaria valer até ${minValidDate.toLocaleDateString('pt-BR')}).`,
        true
      );
      return 'insufficient_validity';
    }

    /* Se não achar data-hora de emissão em nenhuma candidata (layout da
       linha diferente do esperado), cai de volta pra escolher pela
       validade mais distante, com aviso no log — nunca trava o fluxo por
       causa disso. */
    const hasEmittedAt = qualifying.some((c) => c.emittedAt);
    let best;
    if (hasEmittedAt) {
      best = qualifying.filter((c) => c.emittedAt).reduce((a, b) => (b.emittedAt > a.emittedAt ? b : a));
    } else {
      recordDebug(siteKey, 'certidoes_emissao_nao_encontrada', `Nenhuma data-hora de emissão reconhecida em ${qualifying.length} certidão(ões) qualificada(s) — escolhendo pela validade mais distante.`, true);
      best = qualifying.reduce((a, b) => (b.validityDate > a.validityDate ? b : a));
    }
    const bestRow = best.row;
    const bestDate = best.validityDate;

    /* Confirmado em log real: a RFB usa ngx-datatable, onde cada linha é
       dividida em vários div.datatable-row-group IRMÃOS (colunas), não
       aninhados — o grupo com "válida"+data pode não ser o mesmo grupo
       que tem o botão de ação. Sobe até achar o container da linha
       inteira (classe contendo "body-row" ou "row-wrapper", padrão do
       ngx-datatable e de bibliotecas parecidas) antes de procurar o
       botão, em vez de só olhar o grupo específico ou seu pai imediato. */
    const trueRow = bestRow.closest('[class*="body-row"], [class*="row-wrapper"]') || bestRow;

    /* snapshotPage() (e o scan de botões da página) descarta elementos sem
       texto visível — "Segunda Via" provavelmente é um ícone (aria-label
       ou title, sem texto), por isso nunca aparecia em nenhum snapshot.
       Checa texto, aria-label E title; se nada bater com o padrão, cai
       pro fallback de "só existe um elemento clicável na linha" — comum
       em colunas de ação com um único ícone por linha. */
    const clickableSelector = 'a, button, input[type="button"], input[type="submit"], [role="button"]';
    const labelOf = (el) => `${textOf(el)} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.trim();
    function findSegundaVia(scope) {
      const clickables = Array.from(scope.querySelectorAll(clickableSelector)).filter((el) => isVisible(el) && !el.disabled);
      const byHint = clickables.find((el) => SEGUNDA_VIA_HINTS.test(labelOf(el)));
      if (byHint) return byHint;
      return clickables.length === 1 ? clickables[0] : null;
    }

    const segundaViaBtn =
      findSegundaVia(trueRow) ||
      findSegundaVia(bestRow) ||
      (bestRow.parentElement ? findSegundaVia(bestRow.parentElement) : null);
    if (!segundaViaBtn) {
      const clickables = Array.from(trueRow.querySelectorAll(clickableSelector)).filter(isVisible);
      const diag = clickables
        .map((el) => `<${el.tagName.toLowerCase()}> texto="${textOf(el)}" aria-label="${el.getAttribute('aria-label') || ''}" title="${el.getAttribute('title') || ''}" class="${el.className}" (${elementToSelector(el)})`)
        .join(' | ');
      recordDebug(
        siteKey,
        'certidoes_segunda_via_missing',
        `Botão "Segunda Via" não encontrado na linha (${elementToSelector(trueRow)}). Elementos clicáveis na linha: ${diag || 'nenhum'}`,
        true
      );
      return false;
    }

    const fmt = (d) => d.toLocaleDateString('pt-BR');
    const emittedInfo = best.emittedAt ? `, emitida em ${best.emittedAt.toLocaleString('pt-BR')}` : '';
    recordDebug(
      siteKey,
      'certidoes_segunda_via_click',
      `Linha escolhida entre ${qualifying.length} qualificada(s) (validade até ${fmt(bestDate)}${emittedInfo}): "${textOf(segundaViaBtn)}" (${elementToSelector(segundaViaBtn)})`,
      true
    );
    segundaViaBtn.click();
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
  async function processResult(siteKey, cnpj, selectorOverrides, forceEmitNew) {
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

    /* Não retorna aqui (exceto nos casos de erro/reinício): depois de
       completar o sub-fluxo escolhido, a certidão de verdade deve estar
       na tela, e o resto de processResult (procurar o trigger de
       download etc.) segue normalmente. */
    if (classification === 'certidao_valida_existente') {
      const { reuseExistingCertidao, reuseExistingCertidaoMinDays } = await browser.storage.local.get([
        'reuseExistingCertidao',
        'reuseExistingCertidaoMinDays',
      ]);
      /* Reaproveitar é o padrão (true) a menos que o usuário desligue
         explicitamente nas Configurações ou no popup. */
      const wantsReuse = reuseExistingCertidao !== false;
      const minDays = Number.isFinite(reuseExistingCertidaoMinDays) ? reuseExistingCertidaoMinDays : 30;

      if (forceEmitNew || !wantsReuse) {
        recordDebug(
          siteKey,
          'certidao_valida_emitindo_nova',
          forceEmitNew
            ? 'Certidão existente não atendia ao critério de validade mínima configurado — emitindo uma nova.'
            : 'Reaproveitar certidão existente está desativado — emitindo uma nova.',
          true
        );
        const emitted = await handleRfbEmitNovaCertidao(siteKey);
        if (!emitted) {
          sendStatus(siteKey, 'error', 'Certidão válida já existente, mas não foi possível clicar em "Emitir Nova Certidão".');
          return;
        }
        /* Segue para o fluxo normal de emissão abaixo (emit-loop + busca
           de download), igual a qualquer outra certidão nova. */
      } else {
        recordDebug(siteKey, 'certidao_valida_encontrada', `Certidão válida já existente — seguindo Consultar → data de validade → Consultar Certidão (validade mínima exigida: ${minDays} dias).`, true);
        const handled = await handleRfbExistingCertidaoFlow(siteKey, minDays);
        if (handled === 'insufficient_validity') {
          /* A(s) certidão(ões) encontrada(s) não têm validade suficiente —
             recarrega a aba e refaz o fluxo, dessa vez indo direto para
             "Emitir Nova Certidão" (ver background.js: 'restart_for_emit_new'
             marca job.forceEmitNew e o CS_READY seguinte já manda esse
             sinal no RUN_JOB). */
          sendStatus(siteKey, 'restart_for_emit_new');
          return;
        }
        if (!handled) {
          sendStatus(siteKey, 'error', 'Certidão válida já existente, mas não foi possível seguir o fluxo de consulta por data de validade. Verifique a página ou ajuste os seletores.');
          return;
        }
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

    /* Passo específico da Caixa: só depois de clicar no link "Certificado
       de Regularidade do FGTS - CRF" (ver handleCaixaCrfLink acima) é que
       o restante do fluxo genérico abaixo (botão "Visualizar" → segunda
       página com "Imprimir", já coberto por EMIT_STEP_TEXT_HINTS /
       DOWNLOAD_TEXT_HINTS) tem algo pra encontrar. Se o link não existir,
       não adianta seguir procurando botão de emitir/baixar — não existe
       certificado pra este CNPJ; encerra como concluído sem certificado,
       igual ao caso de impedimento tratado acima. */
    if (siteKey === 'caixa') {
      const clickedCrfLink = await handleCaixaCrfLink(siteKey);
      if (!clickedCrfLink) {
        const detail = 'Link "Certificado de Regularidade do FGTS - CRF" não encontrado — não há certificado a emitir para este CNPJ.';
        recordDebug(siteKey, 'caixa_crf_link_missing', detail, true);
        sendStatus(siteKey, 'concluded_without_certificate', detail);
        return;
      }
    }

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

  async function imageElementToBlob(img) {
    try {
      const response = await fetch(img.src);
      return await response.blob();
    } catch (err) {
      return null;
    }
  }

  /* Indicador visual (banner fixo no topo da página + spinner girando)
     enquanto a extensão espera a IA (Nano local ou Gemini na nuvem)
     tentar ler o captcha — essa chamada pode levar alguns segundos, e sem
     nenhum feedback a página fica parada sem explicação nenhuma nesse
     meio tempo. Retorna a função que remove o banner. */
  function showCaptchaSolvingOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'certflow-captcha-solving-overlay';
    Object.assign(overlay.style, {
      position: 'fixed', top: '0', left: '0', right: '0', zIndex: 2147483647,
      background: '#1f6f4a', color: '#fff', padding: '8px 12px',
      font: '13px/1.4 sans-serif', textAlign: 'center', boxShadow: '0 2px 6px rgba(0,0,0,.3)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
    });

    const spinner = document.createElement('span');
    Object.assign(spinner.style, {
      display: 'inline-block', width: '14px', height: '14px',
      border: '2px solid rgba(255,255,255,.4)', borderTopColor: '#fff',
      borderRadius: '50%', animation: 'certflow-captcha-spin 0.8s linear infinite',
    });

    if (!document.getElementById('certflow-captcha-spin-keyframes')) {
      const style = document.createElement('style');
      style.id = 'certflow-captcha-spin-keyframes';
      style.textContent = '@keyframes certflow-captcha-spin { to { transform: rotate(360deg); } }';
      document.head.appendChild(style);
    }

    const label = document.createElement('span');
    label.textContent = 'CertFlow: resolvendo captcha com IA...';

    overlay.appendChild(spinner);
    overlay.appendChild(label);
    document.documentElement.appendChild(overlay);
    return () => overlay.remove();
  }

  /* Tenta resolver o captcha próprio do site (imagem de texto distorcido)
     usando IA, ANTES de cair no fluxo manual (que sempre funciona, mas
     exige o usuário resolver e clicar). Duas fontes, nessa ordem:
     1. Gemini Nano on-device (Chrome, via content/ai.js — só existe nesse
        navegador; em outros, a função global nem existe).
     2. Gemini na nuvem, através da certflow-api própria do usuário (exige
        apiUrl/apiKey configurados em Configurações) — mesmo caminho já
        usado para sugestão de seletores.
     As duas fontes podem falhar por motivos fora do nosso controle (Nano
     não baixado ainda, API própria fora do ar, chave do Gemini sem
     créditos/cota estourada, resposta bloqueada por segurança) — qualquer
     falha aqui é tratada só como "não deu pra resolver agora", nunca como
     erro fatal da execução.
     Retorna { enabled, solved }: "enabled" indica se a resolução por IA
     está ligada nas Configurações (quem chama usa isso pra decidir o que
     fazer quando "solved" for false — reiniciar a consulta se a IA
     estava ligada e falhou, ou cair no fluxo manual normal se estava
     desligada). */
  async function tryAutoSolveCaptcha(siteKey, selectorOverrides) {
    const { cndtCaptchaAiEnabled } = await browser.storage.local.get('cndtCaptchaAiEnabled');
    if (!cndtCaptchaAiEnabled) return { enabled: false, solved: false };

    let hideOverlay = null;
    try {
      const img = resolveElement('captchaImage', siteKey, selectorOverrides, () => findCaptchaImageHeuristic(siteKey));
      const answerSelector = POST_FILL_FOCUS_SELECTOR[siteKey];
      const answerField = answerSelector && document.querySelector(answerSelector);
      if (!img || !answerField) {
        recordDebug(siteKey, 'captcha_ai_no_target', 'Imagem do captcha ou campo de resposta não encontrado.');
        return { enabled: true, solved: false };
      }
      recordDebug(siteKey, 'captcha_ai_attempt', elementToSelector(img));
      hideOverlay = showCaptchaSolvingOverlay();

      let texto = null;
      let source = null;
      if (typeof solveCaptchaImageWithNano === 'function') {
        try {
          const blob = await imageElementToBlob(img);
          if (blob) texto = await solveCaptchaImageWithNano(siteKey, blob);
          if (texto) source = 'nano';
        } catch (err) {
          recordDebug(siteKey, 'captcha_ai_nano_error', String(err && err.message ? err.message : err));
        }
      }

      if (!texto) {
        try {
          const { base64, mime } = await fetchAsBase64(img.src);
          const response = await browser.runtime.sendMessage({ type: 'SOLVE_CAPTCHA', siteKey, imageBase64: base64, mime });
          if (response && response.ok && response.texto && response.confidence !== 'low') {
            texto = response.texto;
            source = 'cloud';
          } else if (response && !response.ok) {
            /* Cobre tanto erro de rede/API própria fora do ar quanto o
               Gemini recusando por falta de créditos/cota — em qualquer
               caso, response.ok é false e texto continua null. */
            recordDebug(siteKey, 'captcha_ai_cloud_error', response.error || 'erro desconhecido');
          }
        } catch (err) {
          recordDebug(siteKey, 'captcha_ai_cloud_error', String(err && err.message ? err.message : err));
        }
      }

      if (!texto) {
        recordDebug(siteKey, 'captcha_ai_failed', 'IA não conseguiu ler o captcha (ou confiança baixa).', true);
        return { enabled: true, solved: false };
      }

      setNativeValue(answerField, texto);
      recordDebug(siteKey, 'captcha_ai_filled', `Campo de resposta preenchido pela IA (${source}): "${texto}"`);
      return { enabled: true, solved: true, texto, source };
    } catch (err) {
      recordDebug(siteKey, 'captcha_ai_error', String(err && err.message ? err.message : err));
      return { enabled: true, solved: false };
    } finally {
      hideOverlay?.();
    }
  }

  /* Fluxo genérico reaproveitado pelos sites automatizados: preenche o
     CNPJ, envia o formulário, aguarda captcha (se aparecer) e resultado, e
     então localiza um jeito de salvar o PDF — link direto (download
     silencioso) ou botão de imprimir/baixar (fallback pedindo 1 clique ao
     usuário via background). */
  async function runFlow(siteKey, cnpj, options) {
    const forceEmitNew = !!(options && options.forceEmitNew);
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
        await processResult(siteKey, cnpj, selectorOverrides, forceEmitNew);
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

      /* Não dá pra confiar em detectCaptcha() aqui: ela só reconhece captchas
         de terceiros (reCAPTCHA/hCaptcha), por iframe ou nome de classe. O
         captcha próprio do CNDT (imagem/áudio + campo de resposta em
         #idCampoResposta, estilo jcaptcha) não bate com nenhum desses
         padrões — dependendo dela, a extensão nunca "via" o captcha e clicava
         sozinha no botão de emitir antes do usuário resolvê-lo (confirmado
         por um usuário). Para os sites desta lista já sabemos, observando o
         site ao vivo, que SEMPRE há um captcha nesta etapa — não precisa
         detectar, só assumir e esperar o usuário resolver e enviar. */
      const captchaAlreadyPresent = SUBMIT_REQUIRES_CAPTCHA_FIRST.has(siteKey);

      /* Se a resolução automática por IA estiver ligada (Configurações) e
         conseguir ler o captcha com confiança, o campo de resposta já sai
         preenchido daqui e o fluxo cai direto no clique automático abaixo,
         igual a um site sem captcha nenhum. Se a IA estava LIGADA mas não
         conseguiu resolver (Nano indisponível, API própria fora do ar,
         Gemini sem créditos/cota, imagem ilegível), reinicia a consulta
         em vez de esperar o usuário — pedido explícito: se a resolução
         automática falhar, tentar de novo do zero, não cair pro manual
         silenciosamente. Reaproveita o mesmo mecanismo de retry/reload já
         usado para "serviço temporariamente indisponível" (até
         UNAVAILABLE_MAX_RETRIES tentativas, depois falha o job). Só quando
         a IA está DESLIGADA é que o fluxo manual de sempre entra em jogo —
         nesse caso nada muda pro usuário. */
      const captchaAutoSolveResult = captchaAlreadyPresent
        ? await tryAutoSolveCaptcha(siteKey, selectorOverrides)
        : { enabled: false, solved: false };

      function reportCaptchaFeedback(success) {
        if (captchaAutoSolveResult.solved && captchaAutoSolveResult.source === 'cloud') {
          browser.runtime
            .sendMessage({ type: 'CAPTCHA_FEEDBACK', siteKey, texto: captchaAutoSolveResult.texto, success })
            .catch(() => {});
        }
      }

      if (captchaAlreadyPresent && captchaAutoSolveResult.enabled && !captchaAutoSolveResult.solved) {
        reportUnavailable(siteKey, 'Não foi possível resolver o captcha automaticamente com IA — reiniciando a consulta.');
        return;
      }

      if (captchaAlreadyPresent && !captchaAutoSolveResult.solved) {
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
        await processResult(siteKey, cnpj, selectorOverrides, forceEmitNew);
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

      /* Confirmado em logs reais: mesmo excluindo header/nav/footer/links do
         texto (ver detectionText), a Receita Federal ainda "detecta
         resultado" entre 6 e 34ms depois do clique — tempo impossível para
         qualquer resposta real. É a página antiga ainda na tela, não o
         resultado da consulta. Isso fazia a classificação rodar cedo
         demais (sempre "regular" genérico, nunca a tela real de "Certidão
         Válida Encontrada"), impedindo o fluxo correto de sequer começar.
         Ignora qualquer detecção nos primeiros instantes — tempo real de
         processamento client-side (Angular/JSF) é sempre maior que isso. */
      const MIN_OUTCOME_DELAY_MS = 700;
      async function waitForOutcome(timeoutMs) {
        const pollStartedAt = Date.now();
        return waitFor(() => {
          if (Date.now() - pollStartedAt < MIN_OUTCOME_DELAY_MS) return null;
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
        /* Nenhum resultado/indisponibilidade reconhecido depois de enviar
           com a resposta que a IA deu pro captcha — o melhor sinal que
           temos de que a leitura provavelmente saiu errada (o site não
           reconheceu a resposta como esperado). Reportado como feedback
           de falha só quando essa consulta usou a solução automática. */
        reportCaptchaFeedback(false);
        const verdict = typeof classifyPageWithAI === 'function' ? await classifyPageWithAI(siteKey) : null;
        if (verdict && verdict.status === 'indisponivel_temporario') {
          reportUnavailable(siteKey, verdict.resumo);
          return;
        }
        recordDebug(siteKey, 'result_missing', 'Nenhum texto de resultado reconhecido após o envio.', true);
        sendStatus(siteKey, 'error', verdict?.resumo || 'A página não retornou um resultado reconhecível. Verifique o CNPJ ou ajuste os seletores.');
        return;
      }

      reportCaptchaFeedback(true);
      await processResult(siteKey, cnpj, selectorOverrides, forceEmitNew);
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
