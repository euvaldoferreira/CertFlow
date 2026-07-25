const { GoogleGenAI } = require('@google/genai');

const MODEL = 'gemini-3.5-flash-lite';

/* O captcha é a barreira de "confirma que é uma pessoa" do próprio site —
   o uso aqui é o titular do CNPJ automatizando o próprio pedido de
   certidão, não uma varredura em massa contra terceiros. Deixamos isso
   explícito no prompt porque é o contexto real da requisição, não pra
   contornar alguma recusa do modelo. */
const SYSTEM_PROMPT = `Você ajuda a ler um captcha de texto (imagem com letras e/ou números
distorcidos, possivelmente com ruído visual como círculos, linhas ou traços ao redor).

Transcreva EXATAMENTE os caracteres visíveis na imagem, na ordem em que aparecem, sem espaços,
respeitando maiúsculas/minúsculas quando for possível distinguir com segurança. Se a imagem não for um
captcha de texto, estiver ilegível, ou você não conseguir ler com confiança razoável, responda com
"texto" vazio e "confidence": "low".

Responda SOMENTE com o JSON pedido, sem texto adicional.`;

const CAPTCHA_SCHEMA = {
  type: 'object',
  properties: {
    texto: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['texto', 'confidence'],
  additionalProperties: false,
};

const MAX_TEXTO_LENGTH = 20;

function client() {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

async function solveCaptchaImage(imageBase64, mime) {
  const response = await client().models.generateContent({
    model: MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Leia o captcha desta imagem.' },
          { inlineData: { mimeType: mime || 'image/png', data: imageBase64 } },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: 'application/json',
      responseJsonSchema: CAPTCHA_SCHEMA,
    },
  });

  /* Cobre tanto uma resposta bloqueada (promptFeedback.blockReason) quanto
     qualquer outro caso sem texto nenhum — nunca lança, só devolve baixa
     confiança pra quem chamou tratar como "não deu". */
  const blockReason = response.promptFeedback?.blockReason;
  const text = response.text;
  if (!text || blockReason) {
    return { texto: '', confidence: 'low' };
  }

  try {
    const parsed = JSON.parse(text);
    return {
      texto: typeof parsed.texto === 'string' ? parsed.texto.trim().slice(0, MAX_TEXTO_LENGTH) : '',
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
    };
  } catch (err) {
    return { texto: '', confidence: 'low' };
  }
}

module.exports = { solveCaptchaImage };
