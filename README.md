# CertFlow

Extensão para Firefox e Chrome que automatiza a emissão de duas certidões a partir de um CNPJ:

1. **Certidão de Regularidade Fiscal** — Receita Federal (`servicos.receitafederal.gov.br/servico/certidoes`)
2. **Certificado de Regularidade do FGTS (CRF)** — Caixa, via Consulta Regularidade do Empregador (`consulta-crf.caixa.gov.br`)

O fluxo abre cada site, preenche o CNPJ, envia o formulário e salva o PDF gerado automaticamente em
`Downloads/CertFlow/<CNPJ>/`. **O único passo manual é resolver o captcha, quando ele aparecer** — o
resto (preencher campo, clicar em consultar, localizar o link de download, salvar o arquivo e passar
para a próxima certidão) é feito pela extensão. No Chrome, o resultado de cada certidão também é
interpretado pelo **Gemini Nano** (IA on-device) — veja a seção própria abaixo.

O código-fonte (`background.js`, `content/`, `lib/`, `popup/`, `options/`, `icons/`) é o mesmo para os
dois navegadores; só o manifesto muda (`manifest.json` para Firefox, `manifest.chrome.json` para Chrome),
porque as duas plataformas exigem formatos de `background` e de ícones diferentes.

## Como instalar

### Firefox (modo desenvolvedor)

1. Abra `about:debugging#/runtime/this-firefox` no Firefox.
2. Clique em **Carregar extensão temporária** e selecione o arquivo `manifest.json` na raiz do projeto.
3. O ícone do CertFlow aparece na barra de ferramentas.

(Extensão temporária é removida ao fechar o Firefox. Para uso permanente, é preciso assinar o pacote
via [addons.mozilla.org](https://addons.mozilla.org) — self-distribution — ou usar o Firefox
Developer/Nightly com `xpinstall.signatures.required = false`.)

### Chrome (modo desenvolvedor)

Chrome exige que o arquivo se chame exatamente `manifest.json` na raiz da pasta carregada, e não aceita
os mesmos formatos de `background`/ícones do Firefox — por isso existe um passo de build que monta uma
pasta própria para cada navegador a partir do mesmo código-fonte:

```bash
./scripts/build.sh chrome   # gera dist-chrome/
# ou ./scripts/build.sh all  para gerar dist-chrome/ e dist-firefox/ de uma vez
```

1. Rode o comando acima.
2. Abra `chrome://extensions`, ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e selecione a pasta `dist-chrome/`.

`dist-firefox/` e `dist-chrome/` são geradas pelo script (não versionadas) — depois de editar qualquer
arquivo fonte, rode o build de novo e clique em "Recarregar" na página de extensões.

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

## Quando o site diz "tente novamente mais tarde"

Às vezes o próprio portal responde algo como *"O serviço de emissão de certidão está temporariamente
indisponível. Tente novamente em alguns minutos."* — isso não é captcha nem o resultado da consulta, é
uma falha passageira do site. O CertFlow reconhece esse tipo de mensagem (por texto e, no Chrome,
também via IA — veja abaixo) e **tenta de novo sozinho**: recarrega a aba e reenvia o CNPJ até 3 vezes,
esperando 90 segundos entre as tentativas, antes de desistir e avisar no log.

## Interpretação por IA (Gemini Nano, só no Chrome)

O Chrome expõe um modelo de linguagem local — o **Gemini Nano**, via *Prompt API for Extensions*, que
roda inteiramente no dispositivo (nada do texto da página é enviado para servidor nenhum). Quando
disponível, o CertFlow usa esse modelo para ler o texto da página de resultado e classificar o que
aconteceu, além da checagem por palavras-chave:

- **Regular** — certidão emitida, empresa sem pendências.
- **Com pendências** — certidão emitida, mas indicando débitos (ex.: "positiva com efeitos de negativa").
- **Indisponível temporariamente** — aciona o retry automático descrito acima.
- **Erro / indeterminado** — casos que a heurística de texto sozinha não cobriria.

O veredito aparece no log de acompanhamento do popup (linha destacada como "IA (Gemini Nano) — ...") e
no log de navegação das Configurações. Se a IA não estiver disponível (Firefox, ou Chrome sem o recurso
habilitado), a extensão simplesmente segue só com a heurística de texto — nada trava por causa disso.

**Pré-requisitos no Chrome** (recurso ainda recente, pode exigir passos manuais dependendo da versão):

1. Chrome atualizado (o "Optimization Guide On Device Model" precisa ter baixado o modelo — confira em
   `chrome://components`, procure por esse componente e clique em "Verificar atualização" se necessário;
   são alguns GB, a primeira vez pode demorar).
2. Se o navegador ainda não expõe `LanguageModel` para extensões, habilite as flags
   `chrome://flags/#optimization-guide-on-device-model` e `chrome://flags/#prompt-api-for-gemini-nano`
   (nomes de flag podem mudar entre versões do Chrome) e reinicie o navegador.
3. Confira o status em `chrome://on-device-internals`.

Sem isso, a extensão continua funcionando normalmente — só não gera o veredito qualitativo.

## Log de navegação (para depurar e calibrar mais rápido)

A cada execução, o CertFlow registra internamente quais campos/botões encontrou (ou não) em cada site —
seletor usado, texto do botão, e, quando algo falha, um retrato estrutural da página (ids, `name`,
`placeholder`, texto de botões visíveis). **Nunca registra o CNPJ digitado nem o conteúdo da certidão**,
só metadados de estrutura da página.

Na tela de **Configurações → Log de navegação**, dá para acompanhar os últimos eventos, baixar o log
completo em JSON (`CertFlow/logs/navegacao_<timestamp>.json` na pasta de downloads) ou limpá-lo. Se a
detecção automática errar um campo, rode uma vez, baixe o log e use-o para ajustar os seletores manuais
(ou para relatar o problema com detalhes precisos).

### Enviar o log para uma API própria (opcional)

A pasta [`api/`](api/) tem uma API local (Node/Express, containerizada) que recebe esses eventos por
HTTP e guarda em disco — útil para acompanhar as execuções sem depender de baixar o JSON manualmente. Ver
[`api/README.md`](api/README.md) para subir com Docker e expor via Cloudflare Tunnel.

Na mesma tela de Configurações, em "Envio para API própria":

1. Preencha a **URL da API** (endpoint `POST /api/logs`, ex.: `https://api-certflow.ecolmea.com/api/logs`)
   e a **chave** (a mesma `API_KEY` definida no `.env` da API).
2. Clique em "Salvar configuração da API".
3. Marque "Enviar automaticamente a cada evento" para que cada passo do fluxo seja enviado em tempo real
   assim que acontece, ou use "Enviar agora" para mandar o log já registrado localmente de uma vez.

O host da API precisa estar declarado em `host_permissions` no `manifest.json` — por padrão já inclui
`https://api-certflow.ecolmea.com/*`; se você trocar de domínio, ajuste o manifest e recarregue a
extensão.

### Auto-atualização de seletores por IA (opcional, requer a API própria)

Com a API do passo acima rodando **e** uma `GEMINI_API_KEY` configurada nela (ver
[api/README.md](api/README.md)), toda vez que a extensão registra um campo "não encontrado" no log,
a API dispara em segundo plano uma análise com o Gemini, que sugere qual seletor usar — escolhendo
sempre entre elementos que a extensão já viu de verdade na página, nunca um seletor inventado (a
resposta é restrita por JSON Schema e revalidada no servidor contra a lista real de candidatos).

**Importante sobre o que isso muda na extensão:** a IA só devolve **configuração** (uma string de
seletor CSS, o mesmo tipo de dado que "Selecionar na página" já grava) — a extensão nunca baixa nem
executa código vindo da API. Isso é proposital: rodar código remoto dentro de uma extensão com acesso
a downloads e aos sites da Receita/Caixa seria um vetor real de execução remota de código, então esse
caminho foi descartado por completo — só dados bounded (seletores já confirmados como reais) entram
em jogo.

Em **Configurações → Sugestões de seletor por IA**:

- **"Preencher automaticamente campos que estão sem configuração"** (desligado por padrão): quando
  ligado, a extensão aplica a sugestão da IA sozinha, mas **só em campos que hoje não têm seletor
  nenhum configurado** — nunca troca silenciosamente um seletor manual ou uma sugestão anterior que
  já estava em uso, mesmo que a IA tenha um palpite diferente depois. Um selo "IA" aparece ao lado de
  qualquer seletor aplicado dessa forma; "Limpar" remove tanto o seletor quanto o selo.
- Para campos que já têm algum seletor configurado, a sugestão fica visível com um botão "Aplicar"
  por campo — a troca só acontece se você clicar.
- **"Verificar agora"** força uma nova análise imediatamente (chama a IA na hora); sem clicar nele, a
  extensão só consulta a última sugestão já calculada (sem custo de IA extra) antes de abrir cada site
  numa execução.

## Onde os arquivos são salvos

`Downloads/<pasta configurada>/<CNPJ sem máscara>/<site>_<timestamp>.pdf`. A pasta padrão é `CertFlow`
e pode ser alterada na página de Configurações.

Quando o site não expõe um link de PDF direto (algumas certidões são páginas HTML pensadas para
impressão), o comportamento depende do navegador:

- **Firefox**: a extensão aciona o diálogo nativo "Salvar como PDF" — um clique extra para confirmar o
  local de salvamento (o Firefox não permite que extensões gravem arquivos arbitrários sem esse gesto).
- **Chrome**: não existe uma API equivalente sem a permissão intrusiva `debugger`, que não faz sentido
  pedir aqui — a extensão avisa no log e o PDF precisa ser salvo manualmente (Ctrl+P) nesse caso
  específico.

## Estrutura do código

- `manifest.json` / `manifest.chrome.json` — os dois manifestos (Firefox e Chrome); `scripts/build.sh`
  monta `dist-firefox/` e `dist-chrome/` a partir deles.
- `background.js` — orquestra a sequência de sites, mensagens dos content scripts, downloads, retry
  automático (via `alarms`) e menu de contexto. Roda como `background.scripts` no Firefox e como
  service worker no Chrome (o próprio arquivo detecta o ambiente e ajusta o carregamento de `lib/`).
- `content/common.js` — heurísticas de DOM, detecção de captcha/resultado/indisponibilidade, modo
  "selecionar na página", fluxo genérico de preenchimento (`runFlow`).
- `content/ai.js` — integração com o Gemini Nano (Chrome); não faz nada em navegadores sem o recurso.
- `content/rfb-certidoes.js`, `content/caixa-crf.js` — pontos de entrada específicos de cada site.
- `lib/cnpj.js` — validação (dígito verificador) e formatação de CNPJ.
- `lib/browser-shim.js` — deixa `browser.*` funcionar também no Chrome (que só expõe `chrome.*`).
- `popup/` — UI de disparo e acompanhamento.
- `options/` — calibração de seletores, pasta de destino, log de navegação e histórico.
- `icons/chrome/` — ícones PNG exigidos pelo Chrome (gerados a partir de `icons/icon.svg`).

## Limitações conhecidas

- Só cobre CNPJ completo (14 dígitos); consulta por CNPJ raiz com seleção de UF não é tratada.
- Captchas são sempre resolvidos manualmente pelo usuário — a extensão nunca tenta contornar ou
  automatizar a resolução deles.
- Os seletores automáticos foram escritos por heurística, sem acesso ao DOM ao vivo dos dois sites no
  momento da criação da extensão; use o modo "Selecionar na página" se a detecção automática falhar.
- A interpretação por IA depende do Gemini Nano estar disponível e com o modelo já baixado no Chrome do
  usuário (ver seção acima); não há fallback equivalente no Firefox, que não tem essa API.
