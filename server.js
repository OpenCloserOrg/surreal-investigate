import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { withSurreal, ensureSchema, surrealConfig } from './lib/surreal.js';
import { extractTextFromFile, chunkText, summarizeText, isSupported } from './lib/extract.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = process.cwd();
const APP_DIR = path.join(ROOT, '.app');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const INDEXES_DIR = path.join(ROOT, 'indexes');
const DATA_DIR = path.join(ROOT, 'data');
const CACHES_JSON = path.join(APP_DIR, 'caches.json');

for (const p of [APP_DIR, UPLOADS_DIR, INDEXES_DIR, DATA_DIR]) fs.mkdirSync(p, { recursive: true });
if (!fs.existsSync(CACHES_JSON)) fs.writeFileSync(CACHES_JSON, JSON.stringify({ caches: [] }, null, 2));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const cacheId = String(req.body.cacheId || '').trim() || `cache-${Date.now()}`;
    const dest = path.join(UPLOADS_DIR, cacheId);
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`)
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

app.use(express.json({ limit: '8mb' }));
app.use('/fixtures', express.static(path.join(ROOT, 'fixtures')));
app.use(express.static(path.join(ROOT, 'public')));

function readCaches() { try { return JSON.parse(fs.readFileSync(CACHES_JSON, 'utf8')); } catch { return { caches: [] }; } }
function writeCaches(data) { fs.writeFileSync(CACHES_JSON, JSON.stringify(data, null, 2)); }
function findCache(data, cacheId) { return (data.caches || []).find((c) => c.id === cacheId); }

function writeManifest(cacheId, manifest) {
  const dir = path.join(INDEXES_DIR, cacheId);
  fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'snapshots', `${ts}.json`), JSON.stringify(manifest, null, 2));
}

async function withTimeout(promise, ms = 15000, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'surreal-investigate', port: PORT }));
app.get('/api/surreal/health', async (_req, res) => {
  try {
    await withTimeout(withSurreal(async (db) => db.query('RETURN 1;')), 5000, 'surreal health check');
    return res.json({ ok: true, surreal: 'reachable', config: surrealConfig });
  } catch (error) {
    return res.status(500).json({ ok: false, surreal: 'unreachable', error: error.message, config: surrealConfig });
  }
});
app.get('/api/config', (_req, res) => res.json({ ok: true, surreal: surrealConfig }));

app.get('/api/caches', (_req, res) => res.json({ ok: true, caches: readCaches().caches || [] }));

app.post('/api/caches', (req, res) => {
  const label = String(req.body?.label || '').trim();
  if (!label) return res.status(400).json({ ok: false, error: 'label required' });
  const data = readCaches();
  const cache = {
    id: `cache-${Date.now()}`,
    label,
    status: 'new',
    readyForQuestions: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    files: [],
    indexStats: null
  };
  data.caches.unshift(cache);
  writeCaches(data);
  fs.mkdirSync(path.join(UPLOADS_DIR, cache.id), { recursive: true });
  fs.mkdirSync(path.join(INDEXES_DIR, cache.id), { recursive: true });
  return res.json({ ok: true, cache });
});

app.post('/api/upload', upload.array('files', 400), (req, res) => {
  const cacheId = String(req.body?.cacheId || '').trim();
  if (!cacheId) return res.status(400).json({ ok: false, error: 'cacheId required' });
  const data = readCaches();
  const cache = findCache(data, cacheId);
  if (!cache) return res.status(404).json({ ok: false, error: 'cache not found' });

  const files = (req.files || []).map((f) => ({
    id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    originalName: f.originalname,
    storedName: path.basename(f.path),
    path: path.relative(ROOT, f.path),
    absPath: f.path,
    size: f.size,
    mimeType: f.mimetype,
    supported: isSupported(f.originalname),
    uploadedAt: new Date().toISOString()
  }));
  cache.files = [...(cache.files || []), ...files];
  cache.updatedAt = new Date().toISOString();
  cache.status = 'files_uploaded';
  cache.readyForQuestions = false;
  writeCaches(data);
  res.json({ ok: true, files, cache });
});

app.post('/api/index/:cacheId', async (req, res) => {
  const cacheId = String(req.params.cacheId || '').trim();
  const data = readCaches();
  const cache = findCache(data, cacheId);
  if (!cache) return res.status(404).json({ ok: false, error: 'cache not found' });
  const logs = [];
  const log = (m) => logs.push({ at: new Date().toISOString(), message: m });

  try {
    log('Connecting to SurrealDB...');
    await withTimeout(withSurreal(async (db) => db.query('RETURN 1;')), 5000, 'surreal precheck');
    const result = await withTimeout(withSurreal(async (db) => {
      await ensureSchema(db);
      log('Schema ensured.');
      await db.query('DELETE document WHERE cacheId = $cacheId; DELETE chunk WHERE cacheId = $cacheId;', { cacheId });
      log('Previous index rows for cache cleared.');

      const allFiles = cache.files || [];
      const files = allFiles.filter((f) => f.absPath && fs.existsSync(f.absPath));
      log(`Cache has ${allFiles.length} file records; ${files.length} files currently readable from disk.`);
      let documentCount = 0;
      let chunkCount = 0;

      for (const file of files) {
        const extracted = await extractTextFromFile(file.absPath, file.originalName);
        if (!extracted.supported) {
          log(`Skipped unsupported file: ${file.originalName}`);
          continue;
        }
        const summary = summarizeText(extracted.text);
        if (!summary.wordCount) {
          log(`Skipped empty extraction: ${file.originalName} (method: ${extracted.method || 'unknown'})`);
          continue;
        }
        await db.query(
          'INSERT INTO document $data;',
          {
            data: {
              cacheId,
              fileId: file.id,
              filename: file.originalName,
              size: file.size,
              mimeType: file.mimeType,
              extractedAt: new Date().toISOString(),
              ...summary
            }
          }
        );
        documentCount += 1;
        const chunks = chunkText(extracted.text, 1400);
        let i = 0;
        for (const text of chunks) {
          i += 1;
          await db.query(
            'INSERT INTO chunk $data;',
            {
              data: {
                cacheId,
                fileId: file.id,
                filename: file.originalName,
                chunkIndex: i,
                text,
                charCount: text.length
              }
            }
          );
          chunkCount += 1;
        }
        log(`Indexed ${file.originalName}: ${summary.wordCount} words, ${chunks.length} chunks (method: ${extracted.method || 'unknown'}).`);
      }

      return { documentCount, chunkCount };
    }), 120000, 'index job');

    const manifest = {
      cacheId,
      indexedAt: new Date().toISOString(),
      status: 'ready',
      stats: result,
      logs
    };
    writeManifest(cacheId, manifest);

    cache.status = 'indexed';
    cache.readyForQuestions = true;
    cache.updatedAt = new Date().toISOString();
    cache.indexStats = result;
    writeCaches(data);

    return res.json({ ok: true, cache, manifest });
  } catch (error) {
    cache.status = 'index_error';
    cache.readyForQuestions = false;
    cache.updatedAt = new Date().toISOString();
    writeCaches(data);
    return res.status(500).json({ ok: false, error: error.message || 'index failed', logs });
  }
});

app.post('/api/query/:cacheId', async (req, res) => {
  const cacheId = String(req.params.cacheId || '').trim();
  const mode = String(req.body?.mode || 'surreal').toLowerCase();
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ ok: false, error: 'question required' });

  try {
    await withTimeout(withSurreal(async (db) => db.query('RETURN 1;')), 5000, 'surreal precheck');
    const chunks = await withTimeout(withSurreal(async (db) => {
      const rows = await db.query(
        `SELECT fileId, filename, chunkIndex, text
         FROM chunk
         WHERE cacheId = $cacheId
         LIMIT 2000;`,
        { cacheId }
      );
      const all = Array.isArray(rows?.[0]) ? rows[0] : (rows?.[0]?.result || []);
      const tokens = String(question || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t && t.length >= 3);
      const score = (txt='') => {
        const v = String(txt || '').toLowerCase();
        let s = 0;
        for (const t of tokens) if (v.includes(t)) s += 1;
        return s;
      };
      return all
        .map((c) => ({ ...c, score: score(c.text) }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
    }), 15000, 'query');

    if (mode === 'surreal') {
      return res.json({
        ok: true,
        mode,
        answer: chunks.length
          ? `Found ${chunks.length} relevant chunk matches in Surreal index.`
          : 'No matching chunks found in Surreal index.',
        evidence: chunks
      });
    }

    const apiKey = String(req.body?.openRouterKey || '').trim();
    const model = String(req.body?.model || '').trim() || 'openai/gpt-4o-mini';
    if (!apiKey) return res.status(400).json({ ok: false, error: 'OpenRouter key required for ai mode.' });

    const prompt = `You are an investigation assistant. Answer using only supplied evidence snippets.\nQuestion: ${question}\n\nEvidence:\n${chunks.map((c, i) => `#${i + 1} ${c.filename} [chunk ${c.chunkIndex}]\n${c.text.slice(0, 1200)}`).join('\n\n')}`;
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.1 })
    });
    const j = await r.json();
    const answer = j?.choices?.[0]?.message?.content || 'No AI answer returned.';

    return res.json({ ok: true, mode, answer, evidence: chunks });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'query failed' });
  }
});

app.post('/api/openrouter/ping', async (req, res) => {
  const key = String(req.body?.key || '').trim();
  const model = String(req.body?.model || '').trim() || 'openai/gpt-4o-mini';
  if (!key) return res.status(400).json({ ok: false, error: 'key required' });
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 })
    });
    const j = await r.json();
    if (!r.ok) return res.status(400).json({ ok: false, error: j?.error?.message || `HTTP ${r.status}` });
    return res.json({ ok: true, model, sample: j?.choices?.[0]?.message?.content || '' });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'ping failed' });
  }
});

app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'public/index.html')));
app.listen(PORT, () => console.log(`Surreal Investigate listening on http://localhost:${PORT}`));
