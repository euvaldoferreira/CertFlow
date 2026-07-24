# CertFlow

Extensão para Firefox e Chrome que automatiza a emissão de certidões a partir de um CNPJ. O usuário
escolhe quais quer emitir (a escolha fica memorizada para a próxima vez):

1. **Certidão de Regularidade Fiscal** — Receita Federal (`servicos.receitafederal.gov.br/servico/certidoes`)
2. **Certificado de Regularidade do FGTS (CRF)** — Caixa, via Consulta Regularidade do Empregador (`consulta-crf.caixa.gov.br`)
3. **CNDT — Certidão Negativa de Débitos Trabalhistas** — TST (`cndt-certidao.tst.jus.br`)
4. **Simples Nacional — Consulta Optantes** (`consopt.www8.receita.fazenda.gov.br/consultaoptantes`) —
   não é a certidão formal (essa exige login gov.br e não é automatizável), mas a consulta pública que
   informa se o CNPJ é optante pelo Simples Nacional

Em todos os quatro, o fluxo abre a aba, preenche o CNPJ, envia o formulário e salva o PDF (ou a página)
gerado automaticamente em `Downloads/CertFlow/<CNPJ>/`. **O único passo manual é resolver o captcha,
quando ele aparecer** — o resto (preencher campo, clicar em consultar, localizar o link de download,
salvar o arquivo) é feito pela extensão. No Chrome, o resultado de cada certidão também é interpretado
pelo **Gemini Nano** (IA on-device) — veja a seção própria abaixo.

Uma certidão emitida com falha ou pendente de captcha **não trava as demais**: ao clicar em "Emitir
certidões", a extensão abre uma aba para **cada** certidão selecionada, todas de uma vez — nenhuma
espera a outra terminar. Cada aba avança sozinha até onde conseguir (só parando para você resolver um
captcha); o progresso de cada uma aparece separado no popup.

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

- **Digitando o CNPJ**: clique no ícone da extensão — abre numa janela própria, centralizada e ocupando
  metade da tela (não é o dropdown pequeno ancorado no ícone, que o navegador não deixa reposicionar).
  Marque as certidões que quer emitir (a seleção fica salva e vem marcada da mesma forma da próxima vez)
  e clique em "Emitir certidões".
- **Via seleção de texto**: selecione um CNPJ em qualquer página, clique com o botão direito e escolha
  "CertFlow: emitir certidões para...". Isso também abre a mesma janela do popup, já com o CNPJ
  preenchido e a última seleção de certidões marcada — nenhuma aba é aberta antes de você confirmar ali.
- Acompanhe o progresso no popup: cada certidão selecionada aparece numa aba própria, aberta em paralelo
  com as demais, marcada como pendente / em andamento (verde claro) / concluído (verde) / erro (vermelho).
  Um quarto estado, **âmbar com o selo "sem certidão"**, aparece quando o processo termina mas não havia
  certidão nenhuma para extrair (ex.: impedimento reportado pela Caixa) — a extensão salva a tela com o
  aviso, mas isso é diferente de ter conseguido de fato a certidão.
- Se um captcha aparecer em alguma das abas, a extensão avisa (notificação do sistema) e pausa **só
  aquele site** até você resolvê-lo; a extração do resultado e o salvamento continuam sozinhos assim que
  o captcha é validado — as outras certidões seguem seu próprio andamento nesse meio tempo.
- Uma certidão que falhar (site indisponível após as tentativas automáticas, CNPJ bloqueado para aquele
  serviço, etc.) não impede as demais de concluir; o resumo final do popup mostra quais deram certo e
  quais falharam.

## Calibrando os seletores (importante na primeira execução)

Os quatro sites automatizados (Receita Federal, Caixa, CNDT, Simples Nacional) são aplicações dinâmicas
(Angular, JSF, formulários clássicos) que mudam de estrutura HTML entre atualizações — não existe um
seletor CSS estável que eu possa garantir sem acessar o DOM renderizado ao vivo. Por isso o CertFlow
tenta localizar os campos automaticamente por heurística
(atributos como `name`/`formcontrolname`/`placeholder` contendo "cnpj", texto do botão como
"Consultar"/"Emitir", link terminando em `.pdf`, etc.), e caso não encontre, permite fixar manualmente:

1. Abra a página do site numa aba.
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

## Certidões com comportamento diferente

**RFB (Pessoa Jurídica)**: quando já existe uma certidão válida emitida para o CNPJ, o site mostra
"Certidão Válida Encontrada" em vez de oferecer emissão direta. Diferente das outras situações, aqui a
extensão **não** clica em "Emitir Nova Certidão" — clica em "Consultar", escolhe a opção "data de
validade" na tela seguinte e preenche o período de hoje até 90 dias à frente, depois clica em "Consultar
Certidão" para chegar à certidão de verdade e seguir o download normalmente. O campo de data final tem
`name="dataFinal"`, mas o de data inicial (confirmado num snapshot real) não tem `name` nenhum, só um id
gerado pelo Angular — por isso os dois são achados juntos num único `waitFor`, que exige dois campos de
texto com o mesmo placeholder ("Selecione a data") visíveis ao mesmo tempo: o que tiver `name="dataFinal"`
é a data final, o outro é a data inicial. A opção "data de validade" é escolhida clicando na **label**
(não só no `<input type="radio">` escondido por trás) — testando manualmente, os campos de data aparecem
em poucos segundos junto com o resto da tela, mas clicar só no input não disparava o efeito completo de
revelar os campos condicionais em automação, um problema comum em componentes customizados desses design
systems de governo, onde o clique de verdade é tratado por um listener na label/wrapper visível.

O RFB também acionava um aviso de "resolva o captcha" sem ter captcha nenhum pra resolver — bug real de
precedência de operadores em `detectCaptcha()` (um `&&`/`||` sem parênteses fazia a checagem de
visibilidade ser ignorada num dos casos), confirmado por um usuário e corrigido.

**CNDT (TST)**: diferente dos outros sites, aqui o captcha precisa ser resolvido **antes** de clicar em
"Emitir Certidão", não depois — clicar cedo demais não funciona. Por isso, se um captcha já estiver
visível logo depois de preencher o CNPJ, a extensão não clica em nada: só avisa (a mesma notificação de
"resolva o captcha") e espera você mesmo resolver e clicar em "Emitir Certidão", monitorando o resultado
em segundo plano a partir daí.

Normalmente gera o PDF na hora, logo depois do captcha, do mesmo jeito que RFB e Caixa — mas esse site
também pode responder que a certidão foi **enviada por e-mail** em vez de mostrar um link de download. A
extensão já reconhece essa mensagem ("emitida e enviada por e-mail") como sucesso; nesse caso o item
aparece concluído no popup, mas o arquivo não fica em `Downloads/`, é preciso checar a caixa de entrada
(e o spam) do e-mail cadastrado.

**Caixa (FGTS)**: além do fluxo normal, o site pode responder que "Constam impedimentos na CAIXA para a
comprovação da regularidade do empregador no FGTS" (com link para a Conectividade Social) em vez de
gerar um certificado. Isso não é um erro de consulta — é uma resposta definitiva de que não há
certificado a emitir para aquele CNPJ agora — então a extensão trata como processo concluído e salva a
tela (com a mensagem) em PDF, em vez de reportar falha.

A página também tem um auto-refresh (`<meta http-equiv="refresh">`, comum em portais JSF de governo pra
aviso de sessão expirando) que, sem intervenção, recarregava a página sozinha e derrubava o resultado
antes de dar tempo de clicar em Visualizar/Imprimir. A extensão bloqueia isso com um script à parte
(`content/caixa-no-refresh.js`) que roda o mais cedo possível (`document_start`) e remove essa tag assim
que ela aparece, inclusive se for inserida via JS depois do carregamento inicial.

**Simples Nacional**: a certidão formal de regularidade desse portal fica atrás de login com conta
gov.br, fora do padrão automatizável das demais — por isso a extensão usa a **Consulta Optantes**
(pública, sem login), que informa se o CNPJ é optante pelo Simples Nacional. A página inicial oficial
(`simplesnacional/aplicacoes.aspx?id=21`) só carrega o formulário dentro de um iframe que começa
**escondido** (`display:none`) e depende de JS do próprio site para aparecer — frágil demais pra
automação. A extensão vai direto ao formulário real, em `consopt.www8.receita.fazenda.gov.br`, uma
página HTML simples sem iframe nem redirecionamento. O captcha é hCaptcha: ao resolvê-lo, o próprio site
recarrega a página inteira com o resultado e o botão "Gerar PDF" (não é uma atualização via ajax) — a
extensão detecta essa recarga (pela ausência do campo de CNPJ) e processa o resultado/PDF já visíveis,
em vez de tentar preencher o CNPJ de novo numa página que não tem mais formulário.

O texto exato de sucesso da consulta ("optante"/"não optante pelo Simples Nacional") foi mapeado por
conhecimento do serviço, não por um teste ao vivo ponta a ponta (a consulta real exige resolver um
captcha) — se a extensão não reconhecer o resultado ou o botão "Gerar PDF" nessa página, ajuste ou
reporte para eu calibrar.

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

### Modo de gravação detalhada

Para diagnosticar problemas mais sutis — não só "campo não encontrado", mas "por que a extensão achou
que tinha um resultado quando não tinha" — existe **Configurações → Log de navegação → Modo de gravação
detalhada**. Ligado, cada execução passa a registrar:

- O retrato estrutural da página em praticamente todo passo (não só nas falhas).
- Exatamente **qual padrão de texto** disparou cada detecção de resultado, com um trecho do texto ao
  redor (`result_match_detail`).
- Quanto tempo se passou entre o clique em consultar/emitir e a detecção do resultado
  (`outcome_timing`) — útil pra pegar falsos positivos: uma detecção em poucos milissegundos não pode
  ser uma resposta real do servidor.

Continua nunca registrando o CNPJ digitado nem o conteúdo da certidão — só estrutura da página (ids,
seletores, texto de botão) e os trechos de texto que batem com os padrões de detecção, que são sempre
avisos genéricos do site, não dados da consulta. Como gera bastante mais eventos que o normal, é pensado
pra ligar só durante uma sessão de diagnóstico, não deixar sempre ativo.

Foi assim, aliás, que se descobriu um bug real: o menu permanente da Caixa tem um link "Certificado de
Regularidade do FGTS - CRF" que já bate com o padrão genérico de resultado — sem o modo detalhado, isso
aparecia só como uma detecção suspeita rápida demais (poucos milissegundos após o clique); com ele, o log
mostra o padrão exato e o trecho de texto que casou, apontando direto pro menu de navegação como causa
(corrigido excluindo cabeçalho/navegação/rodapé/links do texto usado nessas detecções).

Mesmo depois desse ajuste, a Receita Federal continuava "detectando resultado" entre 6 e 34ms após o
clique em "Emitir Certidão" (confirmado em log real, incluindo depois da correção acima) — tempo
impossível para qualquer resposta do servidor, então era outro trecho de texto (fora de header/nav/
footer/links) já presente na própria página antes do clique. Isso fazia a classificação do resultado
rodar sempre em cima da página antiga, nunca dando chance da tela real (ex.: "Certidão Válida
Encontrada") aparecer antes — por isso a extensão nunca seguia o fluxo correto para certidão já
existente, e só salvava a tela em PDF bem mais tarde, quando o timeout do passo de emissão expirava e a
tela real por coincidência já estava visível. Corrigido ignorando qualquer detecção de captcha/resultado/
indisponibilidade nos primeiros ~700ms após o clique — tempo de processamento client-side real (Angular/
JSF) é sempre maior que isso.

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

### Modo de aprendizado (Task Mining / Process Mining)

Às vezes um site tem uma etapa que a extensão simplesmente não tem um campo pronto para representar —
por exemplo, um seletor de UF que precisa ser escolhido antes de consultar, ou uma caixa de "aceito os
termos". Em vez de eu precisar adivinhar isso, dá pra **ensinar fazendo**: em
**Configurações → Modo de aprendizado**, ligue "Ativar modo de aprendizado", abra o site manualmente e
faça o passo que falta você mesmo, uma vez, do jeito normal (clicando, selecionando).

Assim que o modo é ativado numa página, a extensão já registra qual site é e um retrato dos elementos
disponíveis naquele momento (mesmo antes de qualquer clique) — além de, claro, os próprios eventos
observados a seguir. Enquanto ativo, a extensão observa em segundo plano:

- Em quais botões/links você clica (texto do botão + seletor).
- Qual opção você escolhe em campos `<select>` (ex.: qual UF — é um valor de uma lista fechada, não
  digitado, então não tem o mesmo risco de privacidade que texto livre).
- Que um campo de texto foi preenchido — **nunca o que foi digitado nele**. O campo de CNPJ é
  ignorado por completo nessa observação, porque a extensão já sabe lidar com ele sozinha.

Nada disso roda enquanto a própria extensão está executando um fluxo automatizado nesta aba — só
quando é você operando o site manualmente com o modo ligado. Essa sequência observada alimenta a mesma
análise por IA da seção anterior: além de sugerir os 4 campos fixos, a IA pode propor um "passo extra"
(ex.: `ufSelect` → selecionar `"SP"` num `<select>`, ou `aceiteTermos` → clicar num checkbox) — sempre
escolhendo entre elementos reais que a extensão já viu na página, nunca um seletor inventado, e **nunca
código** — só mais um item de configuração, do mesmo jeito que os seletores dos 4 campos fixos. Passos
extras aceitos aparecem na mesma lista de sugestões, com "Aplicar" por item, e são executados
automaticamente logo depois de preencher o CNPJ e antes de clicar em consultar em toda execução
seguinte. Se o elemento configurado sumir da página numa execução futura, esse passo é só pulado (com
aviso no log) — nunca trava o fluxo.

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
- `background.js` — orquestra as certidões selecionadas como **jobs paralelos** (uma aba por certidão,
  abertas ao mesmo tempo, sem uma depender da outra), mensagens dos content scripts, downloads, retry
  automático por site (via `alarms`), modo manual (fecha aba = concluído), menu de contexto e a janela
  do popup (abre `popup/popup.html` como janela própria via `windows.create`, centralizada a 50% da tela
  usando `system.display`, em vez do `default_popup` ancorado no ícone). Roda como `background.scripts`
  no Firefox e como service worker no Chrome (o próprio arquivo detecta o ambiente e ajusta o
  carregamento de `lib/`).
- `content/common.js` — heurísticas de DOM, detecção de captcha/resultado/indisponibilidade/envio por
  e-mail, modo "selecionar na página", fluxo genérico de preenchimento (`runFlow`).
- `content/ai.js` — integração com o Gemini Nano (Chrome); não faz nada em navegadores sem o recurso.
- `content/task-mining.js` — observador passivo do modo de aprendizado; só ativo quando ligado nas
  Configurações e quando é o usuário operando o site manualmente (nunca durante um run automatizado).
- `content/rfb-certidoes.js`, `content/caixa-crf.js`, `content/cndt-certidoes.js`,
  `content/simples-nacional.js` — pontos de entrada específicos de cada site automatizado.
- `content/caixa-no-refresh.js` — roda separado, em `document_start`, só pra bloquear o auto-refresh da
  página da Caixa antes que ele derrube o resultado da tela.
- `lib/cnpj.js` — validação (dígito verificador) e formatação de CNPJ.
- `lib/browser-shim.js` — deixa `browser.*` funcionar também no Chrome (que só expõe `chrome.*`).
- `popup/` — UI de disparo e acompanhamento.
- `options/` — calibração de seletores, pasta de destino, log de navegação e histórico.
- `icons/chrome/` — ícones PNG exigidos pelo Chrome (gerados a partir de `icons/icon.svg`).

## Limitações conhecidas

- Só cobre CNPJ completo (14 dígitos); consulta por CNPJ raiz com seleção de UF não é tratada.
- Captchas são sempre resolvidos manualmente pelo usuário — a extensão nunca tenta contornar ou
  automatizar a resolução deles.
- A certidão formal do Simples Nacional exige login gov.br e não é automatizável; a extensão usa a
  Consulta Optantes (pública) como alternativa — ver "Certidões com comportamento diferente" acima. O
  modo manual (abrir aba e concluir ao fechar) continua existindo na arquitetura para um site futuro que
  realmente precise de login, mas nenhuma das quatro certidões atuais usa esse modo hoje.
- Os seletores automáticos foram escritos por heurística, sem acesso ao DOM ao vivo dos sites no
  momento da criação da extensão; use o modo "Selecionar na página" se a detecção automática falhar.
- A interpretação por IA depende do Gemini Nano estar disponível e com o modelo já baixado no Chrome do
  usuário (ver seção acima); não há fallback equivalente no Firefox, que não tem essa API.
