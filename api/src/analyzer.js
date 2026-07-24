const { GoogleGenAI } = require('@google/genai');

const MODEL = 'gemini-3.6-flash';

const SYSTEM_PROMPT = `Você ajuda a calibrar uma extensão de navegador que preenche formulários
automaticamente em dois portais governamentais brasileiros: o Portal de Certidões da Receita Federal
e a Consulta Regularidade do Empregador da Caixa (FGTS).

Você recebe:
1. Uma lista de elementos candidatos já extraídos da página pela extensão — inputs, botões/links e
   campos <select> — cada um com seu "selector" CSS exato.
2. Um resumo dos últimos eventos de diagnóstico (o que a extensão tentou preencher/clicar e o que
   falhou).
3. Às vezes, uma sequência cronológica de passos que o PRÓPRIO USUÁRIO fez manualmente no site (modo
   de aprendizado / task mining) — cliques, seleções e campos preenchidos, NUNCA os valores digitados
   em campos de texto livre (só que o campo foi preenchido). Use essa sequência como a fonte mais
   confiável de como o fluxo realmente funciona, já que é uma demonstração real.

Sua tarefa tem duas partes:

PARTE 1 — campos fixos. Para cada um dos quatro campos abaixo, escolha o "selector" de UM dos
candidatos fornecidos que melhor corresponde à função pedida, ou null se nenhum candidato servir:

- cnpjInput: campo de texto onde o CNPJ deve ser digitado (não o campo de uma seção de "consultar
  autenticidade de certidão já emitida" — isso é uma função diferente, para checar um número de
  controle, não para emitir uma nova certidão).
- submitButton: botão que envia a consulta/emissão da certidão a partir do CNPJ.
- emitButton: um botão SEPARADO de "emitir"/"obter certidão ou certificado", que só existe quando o
  fluxo tem duas etapas (primeiro consultar a situação, depois um clique extra para emitir/gerar o
  PDF). Use null se não houver essa etapa extra.
- downloadTrigger: link ou botão para baixar, salvar ou imprimir o resultado/certidão.

PARTE 2 — passos extras (extraSteps). Se a sequência observada do usuário (quando fornecida) mostrar
passos que NÃO se encaixam em nenhum dos quatro campos acima — por exemplo, selecionar um estado
(UF) antes de consultar, ou marcar uma caixa de "aceito os termos" — descreva cada um como um item de
"extraSteps": { role (um nome curto em minúsculas, tipo "ufSelect" ou "aceiteTermos"), selector (de
um candidato real), action ("click" para botões/checkboxes ou "select" para <select>), value (só para
action "select": o "value" exato de uma das opções desse candidato — null para "click") }. No máximo
5 itens. Se não houver nenhum passo extra identificável, responda uma lista vazia.

REGRAS OBRIGATÓRIAS:
1. Todo "selector" usado (nos campos fixos ou em extraSteps) deve ser EXATAMENTE IGUAL ao "selector"
   de um dos candidatos listados. Nunca invente, combine ou modifique um seletor.
2. Se não houver um candidato claramente correto para um campo, responda null — não arrisque um
   palpite de baixa confiança.
3. "confidence" reflete sua confiança geral nas escolhas feitas.
4. "notes" deve ser uma frase curta em português explicando o raciocínio principal.

Responda SOMENTE com o JSON pedido, sem texto adicional.`;

const EXTRA_STEP_SCHEMA = {
  type: 'object',
  properties: {
    role: { type: 'string' },
    selector: { type: 'string' },
    action: { type: 'string', enum: ['click', 'select'] },
    value: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['role', 'selector', 'action', 'value'],
  additionalProperties: false,
};

const SUGGESTION_SCHEMA = {
  type: 'object',
  properties: {
    cnpjInput: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    submitButton: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    emitButton: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    downloadTrigger: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    extraSteps: { type: 'array', items: EXTRA_STEP_SCHEMA, maxItems: 5 },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string' },
  },
  required: ['cnpjInput', 'submitButton', 'emitButton', 'downloadTrigger', 'extraSteps', 'confidence', 'notes'],
  additionalProperties: false,
};

const FIELDS = ['cnpjInput', 'submitButton', 'emitButton', 'downloadTrigger'];
const MAX_ROLE_LENGTH = 40;

function findLatestSnapshot(events) {
  for (const event of events) {
    if (event && event.snapshot) return event;
  }
  return null;
}

function summarizeEvents(events) {
  return events
    .slice(0, 40)
    .map((e) => `- ${e.step}${e.detail ? `: ${e.detail}` : ''}`)
    .join('\n');
}

function summarizeObservedSequence(events) {
  const observed = events.filter((e) => e && typeof e.step === 'string' && e.step.startsWith('observed_'));
  if (!observed.length) return '';
  return observed
    .slice()
    .reverse()
    .slice(0, 30)
    .map((e, i) => `${i + 1}. ${e.step.replace('observed_', '')}: ${e.detail || ''}`)
    .join('\n');
}

function client() {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

function emptyFields() {
  return { cnpjInput: null, submitButton: null, emitButton: null, downloadTrigger: null, extraSteps: [] };
}

async function analyzeSite(siteKey, events) {
  const snapshotEvent = findLatestSnapshot(events);
  if (!snapshotEvent) return null;

  const snapshot = snapshotEvent.snapshot;
  const candidateSelectors = new Set([
    ...(snapshot.inputs || []).map((i) => i.selector),
    ...(snapshot.buttons || []).map((b) => b.selector),
    ...(snapshot.selects || []).map((s) => s.selector),
  ]);
  const selectOptionsBySelector = new Map(
    (snapshot.selects || []).map((s) => [s.selector, new Set((s.options || []).map((o) => o.value))])
  );

  const observedSequence = summarizeObservedSequence(events);

  const userMessage = `Site: ${siteKey}
URL: ${snapshot.url || '(desconhecida)'}
Título da página: ${snapshot.title || '(desconhecido)'}

Campos de input candidatos (JSON):
${JSON.stringify(snapshot.inputs || [], null, 2)}

Botões/links candidatos (JSON):
${JSON.stringify(snapshot.buttons || [], null, 2)}

Campos <select> candidatos (JSON):
${JSON.stringify(snapshot.selects || [], null, 2)}

Últimos eventos de diagnóstico desta sessão (mais recente primeiro):
${summarizeEvents(events) || '(nenhum)'}

Sequência observada do usuário operando manualmente (modo de aprendizado), em ordem cronológica:
${observedSequence || '(nenhuma gravação disponível para este site)'}`;

  const response = await client().models.generateContent({
    model: MODEL,
    contents: userMessage,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: 'application/json',
      responseJsonSchema: SUGGESTION_SCHEMA,
    },
  });

  const finishReason = response.candidates?.[0]?.finishReason;
  const blockReason = response.promptFeedback?.blockReason;
  const text = response.text;

  if (!text || blockReason) {
    return {
      ...emptyFields(),
      confidence: 'low',
      notes: `A IA não gerou uma resposta utilizável (${blockReason || finishReason || 'sem texto'}).`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return null;
  }

  /* Defesa em profundidade: mesmo com prompt + JSON schema restringindo a
     resposta, nunca aceitamos um seletor que não seja EXATAMENTE um dos
     candidatos observados de verdade no DOM pela extensão — vale tanto
     para os quatro campos fixos quanto para cada extraStep. */
  const validated = emptyFields();
  for (const field of FIELDS) {
    const value = parsed[field];
    if (typeof value === 'string' && candidateSelectors.has(value)) {
      validated[field] = value;
    }
  }

  if (Array.isArray(parsed.extraSteps)) {
    validated.extraSteps = parsed.extraSteps
      .filter((step) => step && typeof step === 'object')
      .filter((step) => typeof step.selector === 'string' && candidateSelectors.has(step.selector))
      .filter((step) => step.action === 'click' || step.action === 'select')
      .filter((step) => typeof step.role === 'string' && step.role.length > 0 && step.role.length <= MAX_ROLE_LENGTH)
      .filter((step) => {
        if (step.action !== 'select') return true;
        const validValues = selectOptionsBySelector.get(step.selector);
        return validValues && typeof step.value === 'string' && validValues.has(step.value);
      })
      .slice(0, 5)
      .map((step) => ({
        role: step.role.trim().slice(0, MAX_ROLE_LENGTH),
        selector: step.selector,
        action: step.action,
        value: step.action === 'select' ? step.value : null,
      }));
  }

  return {
    ...validated,
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
    notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 500) : '',
    sourceUrl: snapshot.url || null,
  };
}

module.exports = { analyzeSite };
