/* Interpretação do resultado da certidão usando a Prompt API do Chrome
   (Gemini Nano, on-device). Só existe em Chrome/Chromium com o modelo
   habilitado — em qualquer outro navegador (ou Chrome sem o recurso
   habilitado) `classifyPageWithAI` simplesmente retorna null e o resto do
   fluxo (heurística de texto) segue sem depender disso.

   Roda 100% local no dispositivo: o texto da página nunca sai da máquina
   do usuário para fazer essa classificação. */
(function () {
  const MAX_TEXT_LENGTH = 4000;

  const RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['regular', 'positiva_com_pendencia', 'indisponivel_temporario', 'erro', 'desconhecido'],
      },
      resumo: { type: 'string' },
      deveTentarNovamente: { type: 'boolean' },
    },
    required: ['status', 'resumo', 'deveTentarNovamente'],
  };

  const SYSTEM_PROMPT = `Você analisa o texto de páginas de portais governamentais brasileiros que emitem
certidões de regularidade fiscal (Receita Federal) ou certificados de regularidade do FGTS (Caixa).
Dado o texto visível da página após uma consulta, classifique o resultado em EXATAMENTE um destes status:
- "regular": a certidão foi emitida e indica que a empresa está regular/sem pendências.
- "positiva_com_pendencia": a certidão foi emitida mas indica pendências, débitos, ou é uma "certidão positiva com efeitos de negativa".
- "indisponivel_temporario": o site relata uma falha temporária, indisponibilidade do serviço, erro interno, ou pede para tentar novamente mais tarde — não é um resultado sobre a situação fiscal da empresa.
- "erro": um erro definitivo não relacionado a indisponibilidade (ex.: CNPJ inválido, CNPJ não encontrado).
- "desconhecido": o texto não permite concluir nenhum dos casos acima com confiança.
Responda SOMENTE com um objeto JSON no formato {"status": "...", "resumo": "...", "deveTentarNovamente": true|false}.
"resumo" deve ter no máximo 200 caracteres, em português, resumindo o que a página diz. "deveTentarNovamente"
deve ser true apenas quando status for "indisponivel_temporario".`;

  function getEngine() {
    if (typeof LanguageModel !== 'undefined') return LanguageModel;
    if (typeof self !== 'undefined' && self.ai && self.ai.languageModel) return self.ai.languageModel;
    return null;
  }

  function getPageText() {
    const text = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, MAX_TEXT_LENGTH);
  }

  function parseVerdict(raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.status === 'string') {
        return {
          status: parsed.status,
          resumo: String(parsed.resumo || '').slice(0, 200),
          deveTentarNovamente: !!parsed.deveTentarNovamente,
        };
      }
    } catch (err) {
      /* modelo pode responder com texto ao redor do JSON; tenta extrair. */
      const match = /\{[\s\S]*\}/.exec(raw || '');
      if (match) {
        try {
          return parseVerdict(match[0]);
        } catch (err2) {
          return null;
        }
      }
    }
    return null;
  }

  async function classifyPageWithAI(siteKey) {
    const engine = getEngine();
    if (!engine) {
      CertFlow?.recordDebug?.(siteKey, 'ai_unavailable', 'API de IA on-device não existe neste navegador.');
      return null;
    }

    let session = null;
    try {
      const availability = await engine.availability();
      if (availability !== 'available') {
        CertFlow?.recordDebug?.(siteKey, 'ai_unavailable', `Modelo não pronto (status: ${availability}). Veja chrome://on-device-internals.`);
        return null;
      }

      session = await engine.create({
        initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
      });

      const pageText = getPageText();
      const promptOptions = { responseConstraint: RESPONSE_SCHEMA };
      let raw;
      try {
        raw = await session.prompt(`Texto da página:\n"""${pageText}"""`, promptOptions);
      } catch (err) {
        /* Chrome mais antigo pode não suportar responseConstraint. */
        raw = await session.prompt(`Texto da página:\n"""${pageText}"""\n\nResponda apenas com o JSON pedido.`);
      }

      const verdict = parseVerdict(raw);
      if (!verdict) {
        CertFlow?.recordDebug?.(siteKey, 'ai_parse_failed', String(raw || '').slice(0, 300));
        return null;
      }
      CertFlow?.recordDebug?.(siteKey, 'ai_verdict', `${verdict.status}: ${verdict.resumo}`);
      return verdict;
    } catch (err) {
      CertFlow?.recordDebug?.(siteKey, 'ai_error', String(err && err.message ? err.message : err));
      return null;
    } finally {
      session?.destroy?.();
    }
  }

  window.classifyPageWithAI = classifyPageWithAI;
})();
