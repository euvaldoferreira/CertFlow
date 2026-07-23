# CertFlow

Extensão para Firefox que automatiza a emissão de duas certidões a partir de um CNPJ:

1. **Certidão de Regularidade Fiscal** — Receita Federal (`servicos.receitafederal.gov.br/servico/certidoes`)
2. **Certificado de Regularidade do FGTS (CRF)** — Caixa, via Consulta Regularidade do Empregador (`consulta-crf.caixa.gov.br`)

O fluxo abre cada site, preenche o CNPJ, envia o formulário e salva o PDF gerado automaticamente em
`Downloads/CertFlow/<CNPJ>/`. **O único passo manual é resolver o captcha, quando ele aparecer** — o
resto (preencher campo, clicar em consultar, localizar o link de download, salvar o arquivo e passar
para a próxima certidão) é feito pela extensão.

## Como instalar (modo desenvolvedor)

1. Abra `about:debugging#/runtime/this-firefox` no Firefox.
2. Clique em **Carregar extensão temporária** e selecione o arquivo `manifest.json` desta pasta.
3. O ícone do CertFlow aparece na barra de ferramentas.

(Extensão temporária é removida ao fechar o Firefox. Para uso permanente, é preciso assinar o pacote
via [addons.mozilla.org](https://addons.mozilla.org) — self-distribution — ou usar o Firefox
Developer/Nightly com `xpinstall.signatures.required = false`.)

## Como usar

- **Digitando o CNPJ**: clique no ícone da extensão, digite o CNPJ e clique em "Emitir certidões".
- **Via seleção de texto**: selecione um CNPJ em qualquer página, clique com o botão direito e escolha
  "CertFlow: emitir certidões para...". Isso dispensa abrir o popup e digitar.
- Acompanhe o progresso no popup: cada site aparece marcado como pendente / em andamento / concluído.
- Se um captcha aparecer em alguma das abas, a extensão avisa (notificação do sistema + aba fica em
  foco) e pausa **só aquele site** até você resolvê-lo; a extração do resultado e o salvamento continuam
  sozinhos assim que o captcha é validado.

## Calibrando os seletores (importante na primeira execução)

Os dois sites são aplicações dinâmicas (Angular na Receita Federal, JSF na Caixa) que mudam de
estrutura HTML entre atualizações — não existe um seletor CSS estável que eu possa garantir sem acessar
o DOM renderizado ao vivo. Por isso o CertFlow tenta localizar os campos automaticamente por heurística
(atributos como `name`/`formcontrolname`/`placeholder` contendo "cnpj", texto do botão como
"Consultar"/"Emitir", link terminando em `.pdf`, etc.), e caso não encontre, permite fixar manualmente:

1. Abra a página do site (Receita Federal ou Caixa) numa aba.
2. Abra as **Configurações** do CertFlow (link no rodapé do popup, ou `about:addons` → CertFlow →
   Preferências).
3. Clique em "Selecionar na página" ao lado do campo desejado (CNPJ, botão de consultar, botão de
   emitir, ou link/botão de download) e clique no elemento correspondente na aba do site.
4. O seletor fica salvo permanentemente — a heurística automática só é usada quando não há seletor
   salvo para aquele campo.

O portal da Receita Federal costuma ter, na mesma página, uma seção para **emitir** a certidão e outra,
separada, para **consultar a autenticidade** de uma certidão já emitida (por número de controle). A
extensão tenta identificar e ignorar essa segunda seção automaticamente ao procurar o campo de CNPJ e o
botão de consultar, priorizando textos como "Emitir certidão". Se mesmo assim ela acabar usando a seção
errada, ajuste os campos "Campo de CNPJ" e "Botão consultar" pela calibração manual acima.

Alguns fluxos também separam "consultar situação" de "emitir o PDF" em dois cliques distintos. Se for o
caso do site no seu acesso, use o campo opcional **"Botão emitir (se houver etapa separada)"** nas
Configurações para apontar esse segundo botão — a extensão clicará nele automaticamente depois de obter
o resultado da consulta, antes de procurar o link de download.

## Onde os arquivos são salvos

`Downloads/<pasta configurada>/<CNPJ sem máscara>/<site>_<timestamp>.pdf`. A pasta padrão é `CertFlow`
e pode ser alterada na página de Configurações.

Quando o site não expõe um link de PDF direto (algumas certidões são páginas HTML pensadas para
impressão), o CertFlow aciona o diálogo nativo "Salvar como PDF" do Firefox como alternativa — nesse
caso é necessário um clique extra para confirmar o local de salvamento, já que o Firefox não permite
que extensões gravem arquivos arbitrários em disco sem esse gesto do usuário.

## Estrutura do código

- `background.js` — orquestra a sequência de sites, mensagens dos content scripts, downloads e menu de
  contexto.
- `content/common.js` — heurísticas de DOM, detecção de captcha/resultado, modo "selecionar na página",
  fluxo genérico de preenchimento (`runFlow`).
- `content/rfb-certidoes.js`, `content/caixa-crf.js` — pontos de entrada específicos de cada site.
- `popup/` — UI de disparo e acompanhamento.
- `options/` — calibração de seletores, pasta de destino e histórico.
- `lib/cnpj.js` — validação (dígito verificador) e formatação de CNPJ.

## Limitações conhecidas

- Só cobre CNPJ completo (14 dígitos); consulta por CNPJ raiz com seleção de UF não é tratada.
- Captchas são sempre resolvidos manualmente pelo usuário — a extensão nunca tenta contornar ou
  automatizar a resolução deles.
- Os seletores automáticos foram escritos por heurística, sem acesso ao DOM ao vivo dos dois sites no
  momento da criação da extensão; use o modo "Selecionar na página" se a detecção automática falhar.
