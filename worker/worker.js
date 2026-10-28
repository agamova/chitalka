// Читалка на Cloudflare Workers: статика из ./app, данные семей в R2 (ключ `${familyId}/${docId}.json`).
// Вход родителя — по одноразовому коду из письма; устройство получает токен сессии.

const MODELS = {
  default: 'anthropic/claude-sonnet-5.5',
  quick: 'anthropic/claude-haiku-5.5'
};
const CODE_TTL = 10 * 60 * 1000, CODE_TRIES = 5, RESEND_GAP = 60 * 1000, SENDS_PER_HOUR = 5;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8' }
});
const fail = (status, error) => json({ error }, status);
const httpError = (status, error) => Object.assign(new Error(error), { status });

const docKey = (fid, id) => `${fid}/${String(id).replace(/[^a-zA-Z0-9_\-]/g, '_')}.json`;

async function readJson(env, key) {
  const obj = await env.DATA.get(key);
  if (!obj) return null;
  try { return await obj.json(); } catch { return null; }
}
const writeJson = (env, key, data) => env.DATA.put(key, JSON.stringify(data), {
  httpMetadata: { contentType: 'application/json' }
});

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const randomHex = bytes => [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
const randomCode = () => String(100000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900000);

function normEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'bad_email');
  return email;
}

// --- вход по коду ---

async function sendCode(env, email, code) {
  if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Читалка <${env.EMAIL_FROM}>`,
        to: [email],
        subject: `Код для входа в Читалку: ${code}`,
        text: `Ваш код для входа в Читалку: ${code}\n\nОн действует 10 минут. Если вы не запрашивали код, просто удалите это письмо.`,
        html: `<p>Ваш код для входа в Читалку:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>Он действует 10 минут. Если вы не запрашивали код, просто удалите это письмо.</p>`
      })
    });
    if (!res.ok) throw httpError(502, 'email_failed');
    return {};
  }
  if (env.DEV_SHOW_CODE === '1') return { devCode: code };
  throw httpError(503, 'no_email');
}

async function authStart(req, env) {
  const body = await req.json().catch(() => ({}));
  const email = normEmail(body.email);
  const eh = await sha256(email);
  const key = `_auth/codes/${eh}.json`;
  const now = Date.now();
  const prev = (await readJson(env, key)) || {};
  const sends = (prev.sends || []).filter(t => now - t < 3600 * 1000);
  if (sends.length && now - sends[sends.length - 1] < RESEND_GAP) throw httpError(429, 'wait');
  if (sends.length >= SENDS_PER_HOUR) throw httpError(429, 'too_many');
  const code = randomCode();
  await writeJson(env, key, { codeHash: await sha256(code + eh), exp: now + CODE_TTL, tries: 0, sends: sends.concat(now) });
  const extra = await sendCode(env, email, code);
  return json({ ok: true, ...extra });
}

async function authVerify(req, env) {
  const body = await req.json().catch(() => ({}));
  const email = normEmail(body.email);
  const code = String(body.code || '').replace(/\D/g, '');
  const eh = await sha256(email);
  const key = `_auth/codes/${eh}.json`;
  const rec = await readJson(env, key);
  if (!rec || !rec.codeHash) throw httpError(400, 'no_code');
  // Код гасим, но историю отправок оставляем — на ней держится ограничение частоты
  const burn = () => writeJson(env, key, { sends: rec.sends || [] });
  if (Date.now() > rec.exp) { await burn(); throw httpError(400, 'expired'); }
  if (rec.tries >= CODE_TRIES) { await burn(); throw httpError(400, 'too_many_tries'); }
  if (await sha256(code + eh) !== rec.codeHash) {
    rec.tries++; await writeJson(env, key, rec);
    throw httpError(400, 'wrong_code');
  }
  await burn();

  const userKey = `_auth/users/${eh}.json`;
  let user = await readJson(env, userKey);
  if (!user) {
    user = { familyId: randomHex(8), email, created: Date.now() };
    await writeJson(env, userKey, user);
  }
  const token = randomHex(32);
  await writeJson(env, `_auth/sessions/${await sha256(token)}.json`, { familyId: user.familyId, email, created: Date.now() });
  return json({ token, familyId: user.familyId, email });
}

async function session(req, env) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer ([a-f0-9]{64})$/);
  if (!m) throw httpError(401, 'auth');
  const s = await readJson(env, `_auth/sessions/${await sha256(m[1])}.json`);
  if (!s || !s.familyId) throw httpError(401, 'auth');
  return { ...s, token: m[1] };
}

// --- данные и ИИ ---

async function listBooks(env, fid) {
  const keys = [];
  let cursor;
  do {
    const page = await env.DATA.list({ prefix: `${fid}/book_`, cursor });
    page.objects.forEach(o => keys.push(o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const books = await Promise.all(keys.map(k => readJson(env, k)));
  return books.filter(Boolean);
}

async function askAi(env, prompt, tier) {
  if (!env.OPENROUTER_API_KEY) return fail(503, 'no_ai');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'Chitalka'
    },
    body: JSON.stringify({
      model: MODELS[tier] || MODELS.default,
      max_tokens: tier === 'quick' ? 1024 : 8000,
      ...(tier === 'quick' ? { reasoning: { enabled: false } } : {}),
      messages: [{ role: 'user', content: String(prompt) }]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = (err.error && err.error.message) || `OpenRouter error ${res.status}`;
    console.error('ai', tier, res.status, msg);
    return fail(500, msg);
  }
  const data = await res.json();
  const text = (data.choices && data.choices[0] && data.choices[0].message.content) || '';
  const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  try { return json(JSON.parse(m ? m[0] : text)); }
  catch (e) { console.error('ai bad json', tier, text.slice(0, 300)); return fail(500, 'invalid_json'); }
}

async function handleApi(req, env, path) {
  const method = req.method;

  if (path === '/api/auth/start' && method === 'POST') return authStart(req, env);
  if (path === '/api/auth/verify' && method === 'POST') return authVerify(req, env);

  const s = await session(req, env);
  const fid = s.familyId;

  if (path === '/api/auth/me' && method === 'GET') return json({ familyId: fid, email: s.email });
  if (path === '/api/auth/logout' && method === 'POST') {
    await env.DATA.delete(`_auth/sessions/${await sha256(s.token)}.json`);
    return json({ ok: true });
  }

  const m = path.match(/^\/api\/db\/([^/]+)$/);
  if (m) {
    const key = docKey(fid, decodeURIComponent(m[1]));
    if (method === 'GET') {
      const data = await readJson(env, key);
      return data === null ? json(null, 404) : json(data);
    }
    if (method === 'POST') { await writeJson(env, key, await req.json()); return json({ ok: true }); }
    if (method === 'DELETE') { await env.DATA.delete(key); return json({ ok: true }); }
  }

  if (path === '/api/books' && method === 'GET') return json(await listBooks(env, fid));

  if (path === '/api/ai/json' && method === 'POST') {
    const { prompt, tier } = await req.json();
    return askAi(env, prompt, tier);
  }

  return fail(404, 'not_found');
}

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await handleApi(req, env, path);
    } catch (e) {
      return fail(e.status || 500, String(e.message || e));
    }
  }
};
