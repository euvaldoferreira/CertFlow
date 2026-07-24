const { GoogleGenAI } = require('@google/genai');

const MODEL = 'gemini-3.6-flash';

const SYSTEM_PROMPT = `Você ajuda a calibrar seletores CSS para uma extensão de navegador que preenche
formulários automaticamente em dois portais governamentais brasileiros: o Portal de Certidões da
Receita Federal e a Consulta Regularidade do Empregador da Caixa (FGTS).

Você recebe uma lista de elementos candidatos (inputs e botões/links) já extraídos da página pela
extensão — cada um com seu "selector" CSS exato — e um resumo dos últimos eventos de diagnóstico
(o que a extensão tentou preencher/clicar e o que falhou).

Sua tarefa: para cada um dos quatro campos abaixo, escolher o "selector" de UM dos candidatos
fornecidos que melhor corresponde à função pedida, ou null se nenhum candidato servir.

- cnpjInput: campo de texto onde o CNPJ deve ser digitado (não o campo de uma seção de "consultar
  autenticidade de certidão já emitida" — isso é uma função diferente, para checar um número de
  controle, não para emitir uma nova certidão).
- submitButton: botão que envia a consulta/emissão da certidão a partir do CNPJ.
- emitButton: um botão SEPARADO de "emitir certidão", que só existe quando o fluxo tem duas etapas
  (primeiro consultar a situação, depois um clique extra para emitir/gerar o PDF). Use null se não
  houver essa etapa extra — a maioria dos casos não tem.
- downloadTrigger: link ou botão para baixar, salvar ou imprimir o resultado/certidão.

REGRAS OBRIGATÓRIAS:
1. O valor de cada campo de seletor deve ser EXATAMENTE IGUAL ao "selector" de um dos candidatos
   listados, ou null. Nunca invente, combine ou modifique um seletor.
2. Se não houver um candidato claramente correto para um campo, responda null para ele — não
   arrisque um palpite de baixa confiança.
3. "confidence" reflete sua confiança geral nas escolhas feitas (não em cada campo individualmente).
4. "notes" deve ser uma frase curta em português explicando o raciocínio principal (ex.: por que
   descartou algum candidato ambíguo).

Responda SOMENTE com o JSON pedido, sem texto adicional.`;

const SUGGESTION_SCHEMA = {
  type: 'object',
  properties: {
    cnpjInput: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    submitButton: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    emitButton: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    downloadTrigger: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string' },
  },
  required: ['cnpjInput', 'submitButton', 'emitButton', 'downloadTrigger', 'confidence', 'notes'],
  additionalProperties: false,
};

const FIELDS = ['cnpjInput', 'submitButton', 'emitButton', 'downloadTrigger'];

function findLatestSnapshot(events) {
  for (const event of events) {
    if (event && event.snapshot) return event;
  }
  return null;
}

function summarizeEvents(events) {
  return events
    .slice(0, 20)
    .map((e) => `- ${e.step}${e.detail ? `: ${e.detail}` : ''}`)
    .join('\n');
}

function client() {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

function emptyFields() {
  return { cnpjInput: null, submitButton: null, emitButton: null, downloadTrigger: null };
}

async function analyzeSite(siteKey, events) {
  const snapshotEvent = findLatestSnapshot(events);
  if (!snapshotEvent) return null;

  const snapshot = snapshotEvent.snapshot;
  const candidateSelectors = new Set([
    ...(snapshot.inputs || []).map((i) => i.selector),
    ...(snapshot.buttons || []).map((b) => b.selector),
  ]);

  const userMessage = `Site: ${siteKey}
URL: ${snapshot.url || '(desconhecida)'}
Título da página: ${snapshot.title || '(desconhecido)'}

Campos de input candidatos (JSON):
${JSON.stringify(snapshot.inputs || [], null, 2)}

Botões/links candidatos (JSON):
${JSON.stringify(snapshot.buttons || [], null, 2)}

Últimos eventos de diagnóstico desta sessão (mais recente primeiro):
${summarizeEvents(events) || '(nenhum)'}`;

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
     candidatos observados de verdade no DOM pela extensão. */
  const validated = emptyFields();
  for (const field of FIELDS) {
    const value = parsed[field];
    if (typeof value === 'string' && candidateSelectors.has(value)) {
      validated[field] = value;
    }
  }

  return {
    ...validated,
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
    notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 500) : '',
    sourceUrl: snapshot.url || null,
  };
}

module.exports = { analyzeSite };
