# Arena AI Proxy Research

Objetivo: reproduzir chamadas do `https://arena.ai/code/direct` fora do fluxo visual do site, usando cookies autenticados e chamadas HTTP diretas.

## Estado Atual

Conseguimos chamar APIs autenticadas da Arena diretamente por Node.js usando cookies capturados do navegador.

Endpoints confirmados:

```text
GET https://arena.ai/api/me
GET https://arena.ai/api/history/list?limit=2
GET https://arena.ai/api/evaluation/webdev/{modelMessageId}
POST https://arena.ai/nextjs-api/stream/create-evaluation
```

O endpoint principal de conversa funciona direto:

```text
POST /nextjs-api/stream/create-evaluation
content-type: application/json
accept: text/event-stream
```

## Sonnet Capturado

Modelo selecionado na UI:

```text
claude-sonnet-4-6
```

Model ID capturado:

```text
019c6d29-a30c-7e20-9bd0-6650af926623
```

Request capturado pela UI:

```text
GET /submitPrompt?mode=direct-battle&modality=webdev&prompt=oiiiiiii&selectedModel=019c6d29-a30c-7e20-9bd0-6650af926623
POST /nextjs-api/stream/create-evaluation
```

Payload do `create-evaluation`:

```json
{
  "id": "019e843b-82bc-77ee-8172-ff6a515b4c0f",
  "mode": "direct-battle",
  "modelAId": "019c6d29-a30c-7e20-9bd0-6650af926623",
  "userMessageId": "019e843b-85e7-7b94-a290-9e4d599dbf7f",
  "modelAMessageId": "019e843b-85e8-777c-984a-da12badab663",
  "userMessage": {
    "content": "oiiiiiii",
    "experimental_attachments": [],
    "metadata": {}
  },
  "modality": "webdev",
  "recaptchaV3Token": "<recaptcha-token>"
}
```

Resposta SSE capturada:

```text
a2:[{"type":"heartbeat"}]
a2:[{"type":"webdev","event":{"type":"init","files":[],"templateKind":"vanilla"}}]
a2:[{"type":"webdev","event":{"type":"title","title":"Informal user greeting"}}]
a0:"Oi"
a0:"! "
ad:{"finishReason":"stop"}
```

## Requisição Direta Bem-Sucedida

Foi criada uma sessão nova por Node.js com UUIDv7 gerados localmente.

Prompt testado:

```text
responda exatamente: sem-browser-ok
```

Resposta direta:

```text
a0:"sem"
a0:"-browser-ok"
ad:{"finishReason":"stop"}
```

Isso confirma que a sessão não precisa ser criada por uma API separada. O cliente gera:

```text
id
userMessageId
modelAMessageId
```

Todos precisam ser UUIDv7.

## Rate Limits

Headers observados no `create-evaluation`:

```text
ratelimit: limit=1800, remaining=1795, reset=275
ratelimit-limit: 10 ou 30
ratelimit-policy: 1800;w=300
ratelimit-remaining: 9
ratelimit-reset: <unix timestamp>
```

Headers observados no endpoint de avaliação:

```text
ratelimit: limit=9000, remaining=8979, reset=16
ratelimit-policy: 9000;w=300
```

## Autenticação

Cookies necessários:

```text
arena-auth-prod-v1.0=<base64 session payload>
cf_clearance=<cloudflare clearance>
user_country_code=BR
```

Útil, mas nem sempre obrigatório:

```text
_ga=...
_dd_s=...
ph_phc_..._posthog=...
```

O Bearer JWT extraído do cookie sozinho retornou:

```text
401 {"message":"User not found"}
```

Cookies completos retornaram `200`.

## reCAPTCHA

Site key:

```text
6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0
```

A UI chama:

```js
grecaptcha.enterprise.execute("6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0", {
  action: "chat_submit"
})
```

Resultados:

```text
recaptchaV3Token: null -> 403 recaptcha validation failed
token gerado via HTTP direto no Google -> 403 recaptcha validation failed
token gerado dentro da página com grecaptcha.enterprise.execute -> 200
```

Conclusão: o endpoint direto está resolvido; o bloqueio restante para uso 100% sem browser é gerar um token reCAPTCHA Enterprise aceito pelo backend da Arena fora do contexto do navegador.

## Código Client-Side Relevante

Bundle onde foi encontrado o fluxo principal:

```text
/_next/static/chunks/2076-e3675eef7f7e0219.js
```

Função/hook relevante:

```text
appendMultiStream
```

Pontos importantes extraídos:

```js
const userMessageId = generateSafeUUIDv7()
const modelAMessageId = generateSafeUUIDv7()

const payload = {
  id: evaluationSessionId,
  mode,
  modelAId,
  modelBId,
  userMessageId,
  modelAMessageId,
  modelBMessageId,
  userMessage: {
    content,
    experimental_attachments,
    metadata
  },
  modality,
  recaptchaV3Token,
  forceLowRecaptchaScore,
  secrets
}

fetch("/nextjs-api/stream/create-evaluation", {
  method: "POST",
  body: JSON.stringify(payload)
})
```

Para mensagens posteriores em uma sessão existente:

```text
POST /nextjs-api/stream/post-to-evaluation/{evaluationSessionId}
```

## Body Real Capturado

Request real capturado na página da Arena (modelo "Max", prompt "oi"):

```json
{
  "id": "019e8451-97fc-787c-97c5-75240f75b8b5",
  "mode": "direct-battle",
  "modelAId": "019b24bb-5caf-71c3-b854-37d0c7086f21",
  "userMessageId": "019e845b-05e1-7a64-8e3f-cd976f66ac7a",
  "modelAMessageId": "019e845b-05e2-7043-ae06-fdca3d17b3ef",
  "userMessage": {
    "content": "oi",
    "experimental_attachments": [],
    "metadata": {}
  },
  "modality": "webdev",
  "recaptchaV3Token": "<token>"
}
```

Estrutura idêntica à que usamos nos testes diretos.

## Lista Completa de Modelos

Extraídos do `initialModels` no `__next_f` inline script.

### Selecionáveis (webdev ranking)

```text
019b24bb.. Max                    w:MAX
019c6d29.. claude-sonnet-4-6      w:7
019c7820.. gemini-3.1-pro-preview w:20
019e1d78.. gemini-3-pro           w:24
019df477.. gemini-3-flash         w:26
019d049f.. mimo-v2-pro            w:28
019cf4e3.. deep-octo              w:34
019b4231.. minimax-m2.1-preview   w:38
019a2d13.. claude-sonnet-4-5      w:43
019c52a8.. minimax-m2.5           w:45
019a7ebf.. gpt-5.1                w:55
019b352d.. mimo-v2-flash          w:56
019a59bc.. kimi-k2-thinking-turbo w:59
0199e8e9.. claude-haiku-4-5       w:61
019a27e0.. minimax-m2             w:62
af033cbd.. qwen3-coder-480b      w:65
019cb616.. gemini-3.1-flash-lite  w:68
019d50aa.. trinity-large-thinking w:69
019c9aff.. qwen3.5-flash          w:71
019acbac.. mistral-large-3        w:73
0199f060.. gemini-2.5-pro         w:75
019de522.. granite-4.1-8b         w:76
019cc65f.. mercury-2              w:78
```

### Outros selecionáveis (sem rank webdev)

```text
019cc544.. gemini-3.1-pro
019c5826.. gpt-5.2-chat-latest
019ce35a.. grok-4.20-beta-0309-reasoning
019e71ea.. gpt-5.5-instant
019ceb00.. grok-4.20-multi-agent-beta-0309
019cfd71.. gpt-5.4-no-system-prompt
019cddbe.. kiteki
019d2ac4.. dola-seed-2.0-pro-text
019cfcdd.. gpt-5.4-mini-high
019cb505.. gpt-5.3-chat-latest
019becd0.. glm-4.7
019b1449.. gpt-5.2-high
019ce48d.. frieza
019b9784.. qwen3-max-preview
019cc543.. gpt-5.2
019cb680.. kimi-k2.5-instant
019c9270.. qwen3.5-122b-a10b
019c9240.. qwen3.5-27b
019cfcdd.. gpt-5.4-nano-high
019c9254.. qwen3.5-35b-a3b
019d22bb.. step-3.5-flash
019c6e9c.. trinity-large
019cbb13.. march26-chatbot1
019c34f1.. molmo-2-8b
019c6e77.. ring-2.5-1t
019ca598.. ember
019c6eda.. steed-0217
019ca599.. pulse
019c45d7.. glm-5
019a8548.. gpt-5.1-high
```

### Hidden (não selecionáveis na UI atual)

```text
019c2f86.. claude-opus-4-6-thinking
019c2fac.. claude-opus-4-6
019ab8b2.. claude-opus-4-5-thinking-32k
019adbec.. claude-opus-4-5
019cc5aa.. gpt-5.4-high-no-system-prompt
019cc5a9.. gpt-5.4-no-system-prompt (duplicate?)
019d9d7d.. ernie-5.1-preview
019d9808.. claude-opus-4-7-thinking
019d9806.. claude-opus-4-7
```

## Tool Calling (OpenAI-style)

Testamos enviar o campo `tools` e `tool_choice` no payload do `create-evaluation`:

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city",
        "parameters": { ... }
      }
    }
  ],
  "tool_choice": "auto"
}
```

**Resultado**: Status 200, mas o campo é **silenciosamente ignorado**. O modelo responde como texto normal, sem processar as funções customizadas. As únicas `tool_calls` observadas são internas do Arena (`deploy_project`).

Conclusão: a API da Arena **não suporta** OpenAI-style function/tool calling. É um chat simples com geração de texto e ferramentas internas próprias.

## Próximos Passos

## Proxy OpenAI-Compatible

Implementado em:

```text
Arena-AI-PROXY/arena-proxy.js
```

Porta padrão:

```text
9227
```

Durante testes foi iniciado com:

```bat
set PORT=9228 && node C:\Users\Desktop\Desktop\yk\Arena-AI-PROXY\arena-proxy.js
```

Endpoints:

```text
GET  /v1/models
POST /v1/chat/completions
POST /api/session/new
```

Fluxo atual:

1. Recebe request OpenAI-compatible.
2. Monta prompt a partir de `messages`.
3. Se `tools` existir, injeta contrato curto de `<tool_call>{...}</tool_call>`.
4. Pega token reCAPTCHA via session service Playwright.
5. Usa cookie do `.env` (`ARENA_COOKIE`) ou cookies do session service Playwright.
6. Chama `POST https://arena.ai/nextjs-api/stream/create-evaluation`.
7. Parseia SSE `a0:` como texto e `ad:` como finalização.
8. Retorna JSON/SSE OpenAI-compatible.

Variáveis suportadas:

```text
PORT=9228
PROXY_API_KEY=<opcional>
ARENA_COOKIE=<cookie completo>
ARENA_DEFAULT_MODEL_ID=019b24bb-5caf-71c3-b854-37d0c7086f21
ARENA_MODALITY=chat
```

Resultados de smoke test:

```text
Modelo Max 019b24bb-5caf-71c3-b854-37d0c7086f21
non-stream: 200 OpenAI chat.completion
stream: 200 OpenAI SSE sem duplicação
tool-call fake bash: 200 finish_reason=tool_calls
```

Exemplo tool-call retornado:

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_...",
      "type": "function",
      "function": {
        "name": "bash",
        "arguments": "{\"command\":\"pwd\"}"
      }
    }
  ]
}
```

Observações atualizadas:

- Captura real de `https://arena.ai/text/direct` confirmou `mode: "direct-battle"` e `modality: "chat"`.
- `modality: "webdev"` deve ser evitado para proxy de chat/agente porque modelos code/Max entram em fluxo de preview e tendem a responder com geração de página/código.
- Em `modality: "chat"`, o teste `responda exatamente: chat-ok` retornou `chat-ok` limpo.
- Prompt grande com contrato completo causou `429 {"error":"prompt failed"}`; contrato de tools precisa ser curto.
- O session service Playwright (`arena-session.cjs`) mantém uma página aberta para cookies/reCAPTCHA e não chama `page.bringToFront()` ao gerar token, evitando roubar foco da tela.
- Sem o session service Playwright, o proxy falha ao gerar reCAPTCHA.
- Modelo Max em `modality: chat` foi estável nos smoke tests; Sonnet ainda pode bater rate limit/model error.

Smoke tests atualizados:

```text
non-stream chat: 200 content="chat-ok"
tool-call chat: 200 finish_reason="tool_calls" name="bash" arguments={"command":"pwd"}
```

## Próximos Passos

1. Testar `post-to-evaluation/{id}` para conversas multi-turn reais.
2. Melhorar `/v1/models` para listar os modelos de chat extraídos de `models-list.json`.
3. Ajustar modelo padrão para Max ou um chat-ranked estável.
4. Investigar rate limit por modelo (`429 prompt failed`).
5. Melhorar streaming com tool calls para coletar tudo quando `tools` existir e emitir tool call final.

## Segurança

Não commitar:

```text
.env
cookies
cf_clearance
arena-auth-prod-v1.0
JWTs
recaptcha tokens
capturas raw
```

Use `.env.example` como modelo.
