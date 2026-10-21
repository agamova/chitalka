const express = require('express');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'app')));

const ai = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// --- helpers ---

function getFamilyId(req) {
  const id = req.headers['x-family'];
  if (!id || !/^[a-z0-9]{8,24}$/i.test(id)) {
    const e = new Error('Invalid family ID'); e.status = 400; throw e;
  }
  return id;
}

function docPath(familyId, id) {
  const safe = String(id).replace(/[^a-zA-Z0-9_\-]/g, '_');
  return path.join(DATA_DIR, familyId, safe + '.json');
}

function readDoc(familyId, id) {
  try { return JSON.parse(fs.readFileSync(docPath(familyId, id), 'utf8')); }
  catch { return null; }
}

function writeDoc(familyId, id, data) {
  const dir = path.join(DATA_DIR, familyId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(docPath(familyId, id), JSON.stringify(data));
}

function deleteDoc(familyId, id) {
  try { fs.unlinkSync(docPath(familyId, id)); } catch {}
}

// --- DB routes ---

app.get('/api/db/:id', (req, res) => {
  try {
    const data = readDoc(getFamilyId(req), req.params.id);
    if (data === null) return res.status(404).json(null);
    res.json(data);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/db/:id', (req, res) => {
  try {
    writeDoc(getFamilyId(req), req.params.id, req.body);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/db/:id', (req, res) => {
  try {
    deleteDoc(getFamilyId(req), req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/books', (req, res) => {
  try {
    const familyId = getFamilyId(req);
    const dir = path.join(DATA_DIR, familyId);
    const books = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith('book_') && f.endsWith('.json')) {
          try { books.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch {}
        }
      }
    } catch {}
    res.json(books);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Check if a family code exists (for joining)
app.get('/api/family/:code/exists', (req, res) => {
  const code = req.params.code;
  if (!/^[a-z0-9]{8,24}$/i.test(code)) return res.json({ exists: false });
  const family = readDoc(code, 'family');
  res.json({ exists: !!family });
});

// --- AI route ---

const MODELS = {
  default: 'claude-sonnet-4-5',
  quick: 'claude-haiku-4-5'
};

app.post('/api/ai/json', async (req, res) => {
  try {
    getFamilyId(req);
    if (!ai) return res.status(503).json({ error: 'no_ai' });
    const { prompt, tier } = req.body;
    const msg = await ai.messages.create({
      model: MODELS[tier] || MODELS.default,
      max_tokens: 2048,
      messages: [{ role: 'user', content: String(prompt) }]
    });
    const text = msg.content[0].text;
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    res.json(JSON.parse(m ? m[0] : text));
  } catch (e) {
    const code = e.message === 'no_ai' ? 503 : 500;
    res.status(code).json({ error: String(e.message || e) });
  }
});

// SPA fallback
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'app', 'index.html')));

app.listen(PORT, () => console.log(`Читалка: http://localhost:${PORT}`));
