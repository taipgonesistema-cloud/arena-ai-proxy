# Arena AI Proxy

Proxy local compatível com API da OpenAI para usar modelos de chat da **Arena AI** com suporte a **múltiplas contas**, login manual por Playwright, rotação automática em caso de rate limit, streaming e tool calling.

```text
http://localhost:9228/v1
```

---

## Instalação

```bat
npm install
```

---

## Adicionar Contas

```bat
npm run accounts
```

Menu interativo que permite:

1. **Adicionar conta** — abre uma janela limpa do navegador pra você logar manualmente. Quando o login for detectado, os cookies são salvos automaticamente.
2. **Re-fazer login** — se a conta expirou, refaz o login sem perder a configuração.
3. **Remover conta** — remove uma conta do arquivo.
4. **Status de rate limit** — mostra quais contas estão disponíveis e quais estão em cooldown.

As contas ficam salvas em `accounts.json` (ignorado pelo Git). Cada conta armazena os cookies diretamente — sem email/senha no arquivo.

---

## Iniciar o Proxy

```bat
npm start
```

Sobe dois serviços:

| Serviço | Porta | Função |
|---|---|---|
| Session (Playwright) | `9230` | gerencia contas, cookies, reCAPTCHA |
| Proxy | `9228` | API OpenAI-compatible |

O navegador Playwright já abre logado com os cookies da primeira conta disponível.

---

## Endpoints

```text
GET  /v1/models            — Lista modelos disponíveis
POST /v1/chat/completions   — Chat completo (non-stream, stream, tools)
```

### Non-stream

```bat
node -e "fetch('http://localhost:9228/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'arena-default',messages:[{role:'user',content:'responda exatamente: ok'}]})}).then(r=>r.text()).then(console.log)"
```

### Streaming

```bat
node -e "fetch('http://localhost:9228/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'arena-default',messages:[{role:'user',content:'conte de 1 a 5'}],stream:true})}).then(async r=>{for await(const c of r.body)process.stdout.write(c.toString())})"
```

### Tool Calling

O proxy converte `<tool_call>{...}</tool_call>` para o formato OpenAI `tool_calls`. Funciona com Pi, Kilo Code e qualquer cliente OpenAI-compatible.

---

## Autenticação

Por padrão, o proxy roda **aberto** (sem chave). Pra exigir chave, defina no `.env`:

```text
PROXY_API_KEY=sua-chave
```

Envie nas requisições:

```text
Authorization: Bearer sua-chave
```

---

## Fluxo de Cookies

1. Primeiro tenta pegar cookies de uma conta disponível em `accounts.json`
2. Se não houver conta disponível, cai pro fallback da env `ARENA_COOKIES`
3. Se nenhum dos dois existir, retorna erro

Isso garante que as contas logadas manualmente sempre tenham prioridade sobre cookies de ambiente.

---

## Modelos

Listar modelos disponíveis:

```bat
node -e "fetch('http://localhost:9228/v1/models').then(r=>r.json()).then(j=>console.log(j.data.length,'modelos'))"
```

Modelo padrão (Max):

```text
arena-default
```

ID direto:

```text
019b24bb-5caf-71c3-b854-37d0c7086f21
```

---

## Pi.dev / Kilo Code

Adicione no `~/.pi/agent/models.json` (ou `C:\Users\SEU_USER\.pi\agent\models.json`):

```json
{
  "arena-ai": {
    "baseUrl": "http://localhost:9228/v1",
    "api": "openai-completions",
    "apiKey": "dummy",
    "compat": {
      "supportsDeveloperRole": false,
      "supportsReasoningEffort": false
    },
    "models": [
      {
        "id": "arena-default",
        "name": "Arena AI Default Chat",
        "reasoning": false,
        "input": ["text"],
        "contextWindow": 128000,
        "maxTokens": 8192,
        "cost": { "input": 0, "output": 0 }
      }
    ]
  }
}
```

Testar:

```bash
pi --offline --model arena-ai/arena-default -p "Responda exatamente: pi-ok"
```

---

## Scripts

| Comando | Descrição |
|---|---|
| `npm start` | Sobe session + proxy |
| `npm run accounts` | TUI de gerenciamento de contas |
| `npm run accounts:status` | Status rápido das contas |
| `npm run login` | TUI (se tiver contas) ou login legado |
| `npm run check` | Valida sintaxe dos arquivos |

---

## Estrutura

```text
arena-proxy.js        → API OpenAI-compatible
arena-session.cjs     → Playwright session + contas
arena-accounts.cjs    → TUI de contas
login.cjs             → Dispatcher de login
start.cjs             → Orquestrador
data/models-list.json → Lista de modelos versionada
accounts.json         → Cookies das contas (ignorado pelo Git)
```
