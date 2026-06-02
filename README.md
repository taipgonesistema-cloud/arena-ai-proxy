# Arena AI Proxy

Proxy local compatível com a API da OpenAI para usar modelos de chat da Arena AI.

API local:

```text
http://localhost:9228/v1
```

## Instalação

```bat
cd arena-ai-proxy
npm install
```

## Login

```bat
npm run login
```

Faça login na janela aberta. Quando os cookies forem salvos no `.env`, o navegador será fechado automaticamente.

## Iniciar Proxy

```bat
npm start
```

Esse comando inicia o proxy e uma sessão Playwright para gerar reCAPTCHA durante as requisições.

## Endpoints

```text
GET  /v1/models
GET  /models
POST /v1/chat/completions
POST /api/session/new
```

## Teste Rápido

```bat
node -e "fetch('http://localhost:9228/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'arena-default',messages:[{role:'user',content:'responda exatamente: ok'}]})}).then(r=>r.text()).then(console.log)"
```

## Modelos

```bat
node -e "fetch('http://localhost:9228/v1/models').then(r=>r.json()).then(j=>console.log(j.data.length,j.data.slice(0,5)))"
```

Modelo padrão:

```text
arena-default
```

ID padrão:

```text
019b24bb-5caf-71c3-b854-37d0c7086f21
```

## Pi

Configuração do provedor:

```json
{
  "baseUrl": "http://localhost:9228/v1",
  "api": "openai-completions",
  "apiKey": "dummy",
  "compat": {
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": false
  }
}
```

Exemplo:

```bash
pi --offline --model arena-ai/019b24bb-5caf-71c3-b854-37d0c7086f21
```

## Desenvolvimento

Subir login e proxy juntos é o comportamento padrão:

```bat
npm start
```

Checar sintaxe:

```bat
npm run check
```
