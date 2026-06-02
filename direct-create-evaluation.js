const crypto = require('crypto');

const ARENA_COOKIE = process.env.ARENA_COOKIE;
const MODEL_ID = process.env.ARENA_MODEL_ID_SONNET || '019c6d29-a30c-7e20-9bd0-6650af926623';
const RECAPTCHA_TOKEN = process.env.ARENA_RECAPTCHA_TOKEN || null;

if (!ARENA_COOKIE) {
  console.error('Missing ARENA_COOKIE. Copy .env.example to .env and load it before running.');
  process.exit(1);
}

function uuidv7() {
  const bytes = crypto.randomBytes(16);
  const now = BigInt(Date.now());
  bytes[0] = Number((now >> 40n) & 0xffn);
  bytes[1] = Number((now >> 32n) & 0xffn);
  bytes[2] = Number((now >> 24n) & 0xffn);
  bytes[3] = Number((now >> 16n) & 0xffn);
  bytes[4] = Number((now >> 8n) & 0xffn);
  bytes[5] = Number(now & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseArenaSse(text) {
  const chunks = [];
  let finish = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('a0:')) {
      chunks.push(JSON.parse(line.slice(3)));
    } else if (line.startsWith('ad:')) {
      finish = JSON.parse(line.slice(3));
    }
  }
  return { text: chunks.join(''), finish };
}

async function createEvaluation(prompt) {
  const sessionId = uuidv7();
  const userMessageId = uuidv7();
  const modelMessageId = uuidv7();

  const payload = {
    id: sessionId,
    mode: 'direct-battle',
    modelAId: MODEL_ID,
    userMessageId,
    modelAMessageId: modelMessageId,
    userMessage: {
      content: prompt,
      experimental_attachments: [],
      metadata: {},
    },
    modality: 'webdev',
    recaptchaV3Token: RECAPTCHA_TOKEN,
  };

  const res = await fetch('https://arena.ai/nextjs-api/stream/create-evaluation', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': ARENA_COOKIE,
      'Accept': 'text/event-stream',
      'Origin': 'https://arena.ai',
      'Referer': 'https://arena.ai/code/direct',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148 Safari/537.36',
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    requestId: res.headers.get('x-request-id'),
    rateLimit: res.headers.get('ratelimit'),
    raw: body,
    parsed: parseArenaSse(body),
  };
}

const prompt = process.argv.slice(2).join(' ') || 'responda exatamente: sem-browser-ok';
createEvaluation(prompt)
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
