# certflow-api

API local para receber o log de navegação exportado pela extensão CertFlow. Guarda cada lote de eventos
como um arquivo JSON em `data/logs/` (montado como volume Docker) e expõe endpoints simples para
consultar. Não depende de banco de dados externo.

## Subir localmente

```bash
cp .env.example .env
# gere o segredo de assinatura dos access tokens:
openssl rand -hex 32   # cole em JWT_ACCESS_SECRET no .env

# gere o hash da senha do usuário admin (a senha em si nunca fica no .env):
node -e "console.log(require('bcryptjs').hashSync('SUA_SENHA_AQUI', 10))"
# cole o resultado em ADMIN_PASSWORD_HASH no .env, e escolha ADMIN_USERNAME

docker compose up -d --build
curl http://localhost:3000/health
```

A porta padrão é `3000` (ajustável via `PORT` no `.env`). Os dados ficam em `./api/data/logs/`.

## Autenticação

Não existe chave estática fixa — a extensão (ou qualquer cliente) faz login com usuário/senha e recebe
um par de tokens:

- **Access token**: JWT assinado com `JWT_ACCESS_SECRET`, validade de 20 minutos, verificado só por
  assinatura (nada guardado no servidor). Vai no cabeçalho `Authorization: Bearer <accessToken>` de
  toda rota protegida.
- **Refresh token**: string opaca de 32 bytes, validade de 7 dias, guardada no servidor **só como hash**
  (`data/refresh-tokens.json`) junto com validade/revogação/último uso. Cada uso via
  `POST /api/auth/refresh` **rotaciona** o token — o antigo é revogado e um par novo é emitido; reusar
  um refresh token já rotacionado (ex.: um token roubado usado depois do legítimo) é rejeitado.

```bash
# login
curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"SUA_SENHA_AQUI"}'
# -> { accessToken, accessTokenExpiresIn, refreshToken, refreshTokenExpiresIn }

# renovar (rotaciona o refresh token)
curl -s -X POST http://localhost:3000/api/auth/refresh \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"..."}'

# logout (revoga o refresh token)
curl -s -X POST http://localhost:3000/api/auth/logout \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"..."}'
```

`POST /api/auth/login` tem um rate limit próprio, bem mais restrito que o geral (10 tentativas / 15min
por IP), já que é o único endpoint que aceita uma senha.

## Expor via Cloudflare Tunnel

O `cloudflared` local (container `lakehouse-cloudflared`) roda em modo **token** (`cloudflared tunnel run
--token ...`), não com um `config.yml` local — isso significa que o roteamento de hostname é configurado
remotamente, no painel **Cloudflare Zero Trust → Networks → Tunnels → (o túnel) → Public Hostname**, e
não em nenhum arquivo deste repositório.

Como `cloudflared` roda dentro de um container Docker, "localhost" ali dentro é o próprio container do
cloudflared, não o host — por isso `docker-compose.yml` já conecta o `certflow-api` na mesma rede Docker
`lakehouse_frontend` onde o `lakehouse-cloudflared` está (`external: true`, já criada por outra stack).
Com isso o serviço fica acessível de dentro dessa rede como `http://certflow-api:3000` (nome do
container = hostname DNS interno do Docker).

No painel da Cloudflare, configure (ou confira) a entrada de Public Hostname:

| Campo    | Valor                        |
|----------|-------------------------------|
| Subdomain/hostname | `api-certflow.ecolmea.com` |
| Type     | HTTP                          |
| URL      | `certflow-api:3000`           |

Depois de salvar (propaga em segundos), `https://api-certflow.ecolmea.com/health` deve responder
`{"ok":true,...}`. Para testar a conectividade Docker sem depender do domínio público:

```bash
docker run --rm --network lakehouse_frontend busybox wget -qO- http://certflow-api:3000/health
```

Se o `certflow-api` for reiniciado com `docker compose up -d`, ele permanece na rede `lakehouse_frontend`
(está declarado no `docker-compose.yml`); não precisa reconectar manualmente.

## Endpoints

Todos (exceto `/health` e os de `/api/auth/*`) exigem `Authorization: Bearer <accessToken>`.

| Método | Rota                        | Descrição                                              |
|--------|-----------------------------|----------------------------------------------------------|
| GET    | `/health`                   | Healthcheck, sem autenticação.                           |
| POST   | `/api/auth/login`           | `{ username, password }` → par de tokens.                |
| POST   | `/api/auth/refresh`         | `{ refreshToken }` → novo par de tokens (rotação).        |
| POST   | `/api/auth/logout`          | `{ refreshToken }` → revoga o token.                      |
| POST   | `/api/logs`                 | Recebe `{ source, runId, events: [...] }`.               |
| GET    | `/api/logs`                 | Lista os lotes recebidos (metadados, sem `events`).      |
| GET    | `/api/logs/:id`             | Detalha um lote (inclui `events` completo).              |
| DELETE | `/api/logs/:id`             | Remove um lote.                                          |
| POST   | `/api/analyze`              | `{ siteKey }` (ex.: `"rfb"`, `"caixa"`, `"cndt"`) — chama a IA agora e devolve a sugestão. |
| GET    | `/api/suggestions/:siteKey` | Última sugestão já calculada para aquele site.            |
| POST   | `/api/captcha/solve`        | `{ siteKey, imageBase64, mime }` — lê o texto de um captcha via Gemini. |
| POST   | `/api/captcha/feedback`     | `{ siteKey, texto, success }` — registro de acerto/erro da leitura acima. |
| GET    | `/api/captcha/feedback/stats` | Taxa de acerto registrada (opcionalmente `?siteKey=`).  |

Rate limit geral: 120 requisições/min por IP. Corpo máximo: 5 MB.

## Sugestão de seletores por IA (auto-cura)

Quando um lote enviado via `POST /api/logs` contém um evento cujo `step` termina em `_missing`
(ex.: `cnpj_input_missing`) — ou seja, a extensão não achou um campo — a API dispara em segundo plano
uma análise com o **Gemini** (modelo `gemini-3.6-flash`, via `@google/genai`). Requer uma
`GEMINI_API_KEY` definida no `.env` (gere uma em
[aistudio.google.com/apikey](https://aistudio.google.com/apikey)); sem ela, essa análise falha
silenciosamente nos logs do container, sem afetar o resto da API.

A análise lê o retrato estrutural da página mais recente já enviado nos logs (ids, `name`, texto de
botões, seletores — nunca CNPJ nem conteúdo da certidão) e pede ao modelo para escolher, para cada
campo (`cnpjInput`, `submitButton`, `emitButton`, `downloadTrigger`), o seletor exato de um dos
elementos **já observados de verdade na página** — nunca um seletor inventado. Isso é garantido em
duas camadas: a saída é restrita por JSON Schema (`responseJsonSchema`), e o servidor ainda valida que
cada seletor devolvido bate exatamente com um candidato da lista antes de aceitar — qualquer coisa
fora disso é descartada.

O resultado fica salvo em `data/suggestions/<siteKey>.json` e pode ser consultado a qualquer momento
via `GET /api/suggestions/:siteKey`, ou recalculado sob demanda via `POST /api/analyze`. A extensão
(tela de Configurações → "Sugestões de seletor por IA") consome esses endpoints — ver
[README.md](../README.md) principal para o comportamento no lado da extensão.

### Task mining → `extraSteps`

Quando o "modo de aprendizado" está ligado na extensão (ver README principal), os logs também trazem um
evento `observed_page_context` (site + retrato dos elementos disponíveis, registrado assim que o modo é
ativado naquela página, antes de qualquer clique) seguido de `observed_click` / `observed_select` /
`observed_fill` conforme o usuário opera o site manualmente. `analyzeSite()` inclui essa sequência no prompt e o schema de resposta
ganha um campo `extraSteps`: uma lista (máx. 5) de `{ role, selector, action, value }` para passos que
não cabem nos quatro campos fixos (ex.: um `<select>` de UF). As mesmas duas camadas de defesa do
parágrafo acima se aplicam: `role`/`action` vêm de um enum fechado no JSON Schema, e o servidor
revalida que `selector` é um candidato real da página e que `value` (quando `action` é `"select"`) é
uma das opções realmente presentes naquele `<select>` — nunca aceita um valor ou seletor que a IA
tenha inventado.

## Operação

```bash
docker compose logs -f certflow-api   # acompanhar logs
docker compose restart certflow-api   # reiniciar
docker compose down                   # parar e remover o container (dados em ./data são preservados)
```
