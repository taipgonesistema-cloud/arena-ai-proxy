# Arena AI Proxy

Proxy local compatível com a API da OpenAI para usar a Arena AI em clientes como Pi.dev, Kilo Code e qualquer ferramenta que aceite um endpoint OpenAI-compatible.

O projeto usa sessões reais de navegador com Playwright, cookies salvos por conta, rotação entre contas e proxy Tor automático para contornar limites por IP quando necessário.

```text
http://localhost:9228/v1
```

## Recursos

- API local OpenAI-compatible.
- Suporte a `GET /v1/models`.
- Suporte a `POST /v1/chat/completions`.
- Respostas non-stream e streaming SSE.
- Tool calling compatível com o formato da OpenAI.
- Login manual por navegador Playwright.
- Múltiplas contas com cookies salvos em `accounts.json`.
- Rotação automática entre contas quando uma conta entra em rate limit.
- Tor baixado no `npm install` e iniciado automaticamente no `npm start`.
- Fallback local na TUI: as contas aparecem mesmo se o session service estiver offline.

## Instalação

```bat
npm install
```

Durante a instalação, o script `setup-tor.cjs` baixa e extrai o Tor Expert Bundle para a pasta `tor/`.

A pasta `tor/` é ignorada pelo Git. Os binários do Tor não são versionados.

## Iniciar

```bat
npm start
```

O `npm start` faz tudo automaticamente:

- inicia o Tor em `socks5://127.0.0.1:9050`, se o Tor estiver instalado em `tor/`;
- define `PROXY=socks5://127.0.0.1:9050` quando nenhum proxy foi informado manualmente;
- inicia o session service na porta `9230`;
- inicia o proxy OpenAI-compatible na porta `9228`.

Serviços:

| Serviço | Porta | Função |
|---|---:|---|
| Tor | `9050` | Proxy SOCKS5 local |
| Session service | `9230` | Playwright, contas, cookies e reCAPTCHA |
| OpenAI proxy | `9228` | API OpenAI-compatible |

## Contas

Gerenciar contas:

```bat
npm run login
```

A TUI permite:

- adicionar conta;
- refazer login de uma conta;
- remover conta;
- consultar status das contas.

As contas ficam salvas em:

```text
accounts.json
```

Esse arquivo é ignorado pelo Git. Ele contém cookies de sessão, não contém senhas.

Consultar status rápido:

```bat
npm run accounts:status
```

Se o session service estiver offline, a TUI e o comando de status leem `accounts.json` diretamente e avisam que estão usando o fallback local. Para adicionar contas ou refazer login, o `npm start` precisa estar rodando, porque essas ações dependem do navegador Playwright.

## Tor e Proxy

Por padrão, o projeto usa apenas o Tor como proxy.

Fluxo padrão:

```bat
npm install
npm start
```

Não é necessário iniciar o Tor manualmente.

Se quiser usar um proxy diferente, defina `PROXY` antes de iniciar:

```bat
set PROXY=socks5://127.0.0.1:9050
npm start
```

Se quiser passar vários proxies manualmente:

```bat
set PROXY_LIST=socks5://host1:9050,http://host2:8080
npm start
```

Quando um proxy recebe erro ou fica indisponível, ele é marcado como ruim em memória. Com apenas o Tor configurado, a stack pode continuar usando IP real caso o Tor seja marcado como ruim. Reiniciar o `npm start` limpa esse estado em memória.

## Endpoints

### Listar modelos

```text
GET /v1/models
```

Exemplo:

```bat
node -e "fetch('http://localhost:9228/v1/models').then(r=>r.json()).then(j=>console.log(j.data.length,'modelos'))"
```

### Chat completions

```text
POST /v1/chat/completions
```

Exemplo non-stream:

```bat
node -e "fetch('http://localhost:9228/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'arena-default',messages:[{role:'user',content:'responda exatamente: ok'}]})}).then(r=>r.text()).then(console.log)"
```

Exemplo streaming:

```bat
node -e "fetch('http://localhost:9228/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'arena-default',messages:[{role:'user',content:'responda exatamente: stream-ok'}],stream:true})}).then(r=>r.text()).then(console.log)"
```

## Tool Calling

A Arena AI não fornece tool calling nativo no mesmo formato da OpenAI. O proxy injeta um contrato textual no prompt e converte respostas no formato abaixo para `tool_calls` OpenAI-compatible:

```text
<tool_call>{"name":"echo","arguments":{"text":"ok"}}</tool_call>
```

O proxy também filtra argumentos extras que não existam no schema da ferramenta. Isso evita chamadas inválidas, por exemplo `description` dentro de `arguments` quando o schema não permite essa chave.

O suporte cobre:

- `tool_choice: "none"`;
- `tool_choice: "required"`;
- `tool_choice` com função específica;
- streaming com tool calls;
- mensagens `developer` convertidas para instruções preservadas no prompt.

## Modelo Padrão

Alias padrão:

```text
arena-default
```

ID usado pelo alias:

```text
019b24bb-5caf-71c3-b854-37d0c7086f21
```

## Autenticação do Proxy

Por padrão, o proxy local não exige chave.

Para exigir autenticação, crie ou edite `.env`:

```text
PROXY_API_KEY=sua-chave
```

Depois envie nas requisições:

```text
Authorization: Bearer sua-chave
```

## Pi.dev e Kilo Code

Arquivo no Windows:

```text
C:\Users\SEU_USUARIO\.pi\agent\models.json
```

Exemplo completo do `models.json`:

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

Se já existir outro provider no arquivo, mantenha os providers existentes e adicione apenas a chave `"arena-ai"` no objeto principal.

Teste:

```bat
pi --offline --model arena-ai/arena-default -p "Responda exatamente: pi-ok"
```

Teste sem ferramentas:

```bat
pi --offline --no-tools --model arena-ai/arena-default -p "Responda exatamente: pi-ok"
```

Teste com ferramentas:

```bat
pi --offline --model arena-ai/arena-default -p "Use uma ferramenta para ver onde estamos e responda apenas com o caminho atual."
```

## Scripts

| Comando | Descrição |
|---|---|
| `npm install` | Instala dependências e baixa o Tor automaticamente |
| `npm start` | Inicia Tor, session service e proxy |
| `npm run login` | Abre a TUI de gerenciamento de contas |
| `npm run accounts:status` | Mostra status rápido das contas |
| `npm run doctor` | Diagnostica Tor, portas, contas e endpoints |
| `npm run proxy` | Inicia apenas o proxy OpenAI-compatible |
| `npm run session` | Inicia apenas o session service |
| `npm run check` | Valida a sintaxe dos arquivos principais |

## Estrutura

```text
arena-proxy.js         API OpenAI-compatible
arena-session.cjs      Session service com Playwright, contas, Tor e reCAPTCHA
arena-accounts.js      TUI de gerenciamento de contas
start.cjs              Orquestrador: Tor + session + proxy
setup-tor.cjs          Instalador automático do Tor Expert Bundle
doctor.cjs             Diagnóstico da instalação e dos serviços
data/models-list.json  Lista versionada de modelos
accounts.json          Cookies das contas, ignorado pelo Git
tor/                   Binários do Tor, ignorado pelo Git
```

## Arquivos Sensíveis

Não versionar:

- `accounts.json`;
- `.env`;
- `tor/`;
- logs;
- cookies;
- tokens;
- dumps de rede;
- traces brutos.

Esses itens já estão cobertos pelo `.gitignore`.

## Solução de Problemas

### `npm run login` mostra nenhuma conta

Verifique se existe `accounts.json` na raiz do projeto:

```bat
dir accounts.json
```

Se o session service estiver offline, a TUI deve mostrar as contas locais e avisar que está usando fallback. Para adicionar ou refazer login, rode:

```bat
npm start
```

### Tor não inicia

Reinstale o Tor automático:

```bat
rmdir /s /q tor
npm install
```

Depois inicie novamente:

```bat
npm start
```

### `429 prompt failed`

Esse erro geralmente indica limite da conta. O proxy tenta alternar para outra conta disponível. Se todas as contas retornarem o mesmo erro, adicione outra conta ou aguarde o limite expirar.

### `429 Too Many Requests`

Esse erro geralmente indica limite global ou por IP. O Tor é iniciado automaticamente para reduzir esse problema. Se o Tor também for limitado, reiniciar o Tor pode trocar o circuito, mas a disponibilidade depende dos nós de saída da rede Tor.

### Conferir saúde da stack

```bat
node -e "fetch('http://127.0.0.1:9230/status').then(r=>r.json()).then(console.log)"
```

Healthcheck completo do session service:

```bat
node -e "fetch('http://127.0.0.1:9230/health').then(r=>r.json()).then(console.log)"
```

```bat
node -e "fetch('http://127.0.0.1:9228/v1/models').then(r=>r.json()).then(console.log)"
```

Diagnóstico geral:

```bat
npm run doctor
```

### Trocar circuito do Tor

Com a stack rodando, solicite um novo circuito Tor:

```bat
node -e "fetch('http://127.0.0.1:9230/tor/newnym',{method:'POST'}).then(r=>r.json()).then(console.log)"
```

Isso envia `SIGNAL NEWNYM` para o ControlPort do Tor, limpa o estado de proxies ruins em memória e recria os runtimes das contas no próximo uso.

## Observações

- Uma janela de navegador Playwright pode abrir durante login ou sessão.
- A Arena AI pode alterar seletores, endpoints ou políticas de limite.
- Tor é mais lento que o IP real; os timeouts foram ajustados para essa latência.
- Proxies gratuitos públicos foram removidos do fluxo padrão porque são instáveis e, em geral, já estão bloqueados.

## Licença

Este projeto está licenciado sob a licença MIT. Consulte o arquivo `LICENSE`.
