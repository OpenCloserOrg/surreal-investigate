import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { withSurreal, ensureSchema, surrealConfig } from './lib/surreal.js';
import { extractTextFromFile, chunkText, summarizeText, isSupported } from './lib/extract.js';
import { analyzeChunk, buildCooccurrenceRelations, tokenize } from './lib/investigate.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = process.cwd();
const APP_DIR = path.join(ROOT, '.app');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const INDEXES_DIR = path.join(ROOT, 'indexes');
const DATA_DIR = path.join(ROOT, 'data');
const CHAT_LOGS_DIR = path.join(ROOT, 'chat-logs');
const CACHES_JSON = path.join(APP_DIR, 'caches.json');

for (const p of [APP_DIR, UPLOADS_DIR, INDEXES_DIR, DATA_DIR, CHAT_LOGS_DIR]) fs.mkdirSync(p, { recursive: true });
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
function logServer(step, payload = {}) { console.log(`[surreal-investigate] ${step}`, payload); }

function chatLogPath(cacheId, chatId) {
  const dir = path.join(CHAT_LOGS_DIR, cacheId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${chatId}.json`);
}
function readChatLog(cacheId, chatId) {
  const p = chatLogPath(cacheId, chatId);
  if (!fs.existsSync(p)) return { cacheId, chatId, createdAt: new Date().toISOString(), messages: [] };
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { cacheId, chatId, createdAt: new Date().toISOString(), messages: [] }; }
}
function appendChatLog(cacheId, chatId, entry) {
  const data = readChatLog(cacheId, chatId);
  data.updatedAt = new Date().toISOString();
  data.messages.push({ at: new Date().toISOString(), ...entry });
  fs.writeFileSync(chatLogPath(cacheId, chatId), JSON.stringify(data, null, 2));
}
function listChats(cacheId) {
  const dir = path.join(CHAT_LOGS_DIR, cacheId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => {
      const p = path.join(dir, n);
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return {
        chatId: n.replace(/\.json$/, ''),
        updatedAt: data.updatedAt || data.createdAt || '',
        messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
        title: data.title || ''
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

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
app.get('/api/chats/:cacheId', (req, res) => {
  const cacheId = String(req.params.cacheId || '').trim();
  return res.json({ ok: true, chats: listChats(cacheId) });
});
app.post('/api/chats/:cacheId', (req, res) => {
  const cacheId = String(req.params.cacheId || '').trim();
  const chatId = `chat-${Date.now()}`;
  const title = String(req.body?.title || '').trim() || 'New investigation chat';
  const p = chatLogPath(cacheId, chatId);
  fs.writeFileSync(p, JSON.stringify({ cacheId, chatId, title, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] }, null, 2));
  return res.json({ ok: true, chatId, title });
});
app.get('/api/chats/:cacheId/:chatId', (req, res) => {
  const cacheId = String(req.params.cacheId || '').trim();
  const chatId = String(req.params.chatId || '').trim();
  return res.json({ ok: true, chat: readChatLog(cacheId, chatId) });
});

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
  logServer('upload:start', { cacheId: req.body?.cacheId, fileCount: (req.files || []).length });
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
  logServer('upload:done', { cacheId, uploaded: files.length, totalInCache: cache.files.length });
  res.json({ ok: true, files, cache });
});

app.post('/api/index/:cacheId', async (req, res) => {
  const cacheId = String(req.params.cacheId || '').trim();
  const indexStrategy = String(req.body?.indexStrategy || '').trim() || 'balanced';
  const indexStrategyNotes = String(req.body?.indexStrategyNotes || '').trim();
  const data = readCaches();
  const cache = findCache(data, cacheId);
  if (!cache) return res.status(404).json({ ok: false, error: 'cache not found' });
  const logs = [];
  const log = (m) => logs.push({ at: new Date().toISOString(), message: m });

  try {
    logServer('index:start', { cacheId, indexStrategy, indexStrategyNotes: indexStrategyNotes.slice(0, 180) });
    log(`Index strategy: ${indexStrategy}${indexStrategyNotes ? ` (${indexStrategyNotes.slice(0, 120)})` : ''}`);
    log('Connecting to SurrealDB...');
    await withTimeout(withSurreal(async (db) => db.query('RETURN 1;')), 5000, 'surreal precheck');
    const result = await withTimeout(withSurreal(async (db) => {
      await ensureSchema(db);
      log('Schema ensured.');
      await db.query(
        'DELETE document WHERE cacheId = $cacheId; DELETE chunk WHERE cacheId = $cacheId; DELETE entity WHERE cacheId = $cacheId; DELETE event WHERE cacheId = $cacheId; DELETE relation WHERE cacheId = $cacheId; DELETE anomaly WHERE cacheId = $cacheId;',
        { cacheId }
      );
      log('Previous index rows for cache cleared (documents, chunks, entities, events, relations, anomalies).');

      const allFiles = cache.files || [];
      const files = allFiles.filter((f) => f.absPath && fs.existsSync(f.absPath));
      log(`Cache has ${allFiles.length} file records; ${files.length} files currently readable from disk.`);
      let documentCount = 0;
      let chunkCount = 0;
      let entityCount = 0;
      let eventCount = 0;
      let relationCount = 0;
      let anomalyCount = 0;

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

          const analysis = analyzeChunk(text);
          for (const entity of analysis.entities) {
            await db.query('INSERT INTO entity $data;', { data: { cacheId, fileId: file.id, filename: file.originalName, chunkIndex: i, ...entity } });
            entityCount += 1;
          }
          for (const ev of analysis.events) {
            await db.query('INSERT INTO event $data;', { data: { cacheId, fileId: file.id, filename: file.originalName, chunkIndex: i, ...ev } });
            eventCount += 1;
          }
          for (const an of analysis.anomalies) {
            await db.query('INSERT INTO anomaly $data;', { data: { cacheId, fileId: file.id, filename: file.originalName, chunkIndex: i, ...an } });
            anomalyCount += 1;
          }
          const relations = buildCooccurrenceRelations(analysis.entities);
          for (const rel of relations) {
            await db.query('INSERT INTO relation $data;', { data: { cacheId, fileId: file.id, filename: file.originalName, chunkIndex: i, ...rel } });
            relationCount += 1;
          }
        }
        log(`Indexed ${file.originalName}: ${summary.wordCount} words, ${chunks.length} chunks, entities=${entityCount}, events=${eventCount}, anomalies=${anomalyCount} (method: ${extracted.method || 'unknown'}).`);
      }

      return { documentCount, chunkCount, entityCount, eventCount, relationCount, anomalyCount };
    }), 120000, 'index job');

    const manifest = {
      cacheId,
      indexedAt: new Date().toISOString(),
      status: 'ready',
      strategy: { name: indexStrategy, notes: indexStrategyNotes },
      indexingExplanation: [
        '1) Extract readable text from each file.',
        '2) Create document metadata rows (filename, size, word counts).',
        '3) Split text into chunks and store chunk rows for retrieval.',
        '4) Derive structured intelligence per chunk: entities, events, anomalies, and co-occurrence relations.',
        '5) Query combines lexical chunk retrieval with structured tables for investigative patterning.'
      ],
      stats: result,
      logs
    };
    writeManifest(cacheId, manifest);

    cache.status = 'indexed';
    cache.readyForQuestions = true;
    cache.updatedAt = new Date().toISOString();
    cache.indexStats = result;
    writeCaches(data);
    logServer('index:done', { cacheId, ...result });

    return res.json({ ok: true, cache, manifest });
  } catch (error) {
    cache.status = 'index_error';
    cache.readyForQuestions = false;
    cache.updatedAt = new Date().toISOString();
    writeCaches(data);
    logServer('index:error', { cacheId, error: error.message });
    return res.status(500).json({ ok: false, error: error.message || 'index failed', logs });
  }
});

app.post('/api/query/:cacheId', async (req, res) => {
  const cacheId = String(req.params.cacheId || '').trim();
  const mode = String(req.body?.mode || 'surreal').toLowerCase();
  const question = String(req.body?.question || '').trim();
  const queryStrategy = String(req.body?.queryStrategy || '').trim() || 'balanced';
  const queryStrategyNotes = String(req.body?.queryStrategyNotes || '').trim();
  const chatId = String(req.body?.chatId || '').trim() || `chat-${Date.now()}`;
  if (!question) return res.status(400).json({ ok: false, error: 'question required' });

  try {
    logServer('query:start', { cacheId, mode, chatId, queryStrategy });
    await withTimeout(withSurreal(async (db) => db.query('RETURN 1;')), 5000, 'surreal precheck');
    const retrieval = await withTimeout(withSurreal(async (db) => {
      const [chunkRows, entityRows, eventRows, anomalyRows, relationRows] = await Promise.all([
        db.query(`SELECT fileId, filename, chunkIndex, text FROM chunk WHERE cacheId = $cacheId LIMIT 3000;`, { cacheId }),
        db.query(`SELECT type, value, normalized, filename, chunkIndex, confidence FROM entity WHERE cacheId = $cacheId LIMIT 3000;`, { cacheId }),
        db.query(`SELECT type, amount, currency, rawAmount, filename, chunkIndex, confidence FROM event WHERE cacheId = $cacheId LIMIT 3000;`, { cacheId }),
        db.query(`SELECT type, severity, rationale, filename, chunkIndex FROM anomaly WHERE cacheId = $cacheId LIMIT 3000;`, { cacheId }),
        db.query(`SELECT type, sourceType, sourceValue, targetType, targetValue, filename, chunkIndex FROM relation WHERE cacheId = $cacheId LIMIT 3000;`, { cacheId })
      ]);

      const rowsToList = (rows) => (Array.isArray(rows?.[0]) ? rows[0] : (rows?.[0]?.result || []));
      const allChunks = rowsToList(chunkRows);
      const allEntities = rowsToList(entityRows);
      const allEvents = rowsToList(eventRows);
      const allAnomalies = rowsToList(anomalyRows);
      const allRelations = rowsToList(relationRows);

      const tokens = tokenize(question);
      const scoreText = (txt='') => {
        const v = String(txt || '').toLowerCase();
        let s = 0;
        for (const t of tokens) if (v.includes(t)) s += 1;
        return s;
      };

      const chunks = allChunks
        .map((c) => ({ ...c, score: scoreText(c.text) }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);

      const byTokenMatch = (obj) => {
        const v = JSON.stringify(obj).toLowerCase();
        let s = 0;
        for (const t of tokens) if (v.includes(t)) s += 1;
        return s;
      };

      const entities = allEntities.map((e) => ({ ...e, score: byTokenMatch(e) })).filter((e) => e.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
      const events = allEvents.map((e) => ({ ...e, score: byTokenMatch(e) })).filter((e) => e.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
      const anomalies = allAnomalies.map((a) => ({ ...a, score: byTokenMatch(a) })).filter((a) => a.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);
      const relations = allRelations.map((r) => ({ ...r, score: byTokenMatch(r) })).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);

      return { chunks, entities, events, anomalies, relations, tokenCount: tokens.length };
    }), 20000, 'query');

    const chunks = retrieval.chunks;

    if (mode === 'surreal') {
      const summary = [
        `Chunks: ${chunks.length}`,
        `Entities: ${retrieval.entities.length}`,
        `Events: ${retrieval.events.length}`,
        `Anomalies: ${retrieval.anomalies.length}`,
        `Relations: ${retrieval.relations.length}`
      ].join(' | ');
      const answer = chunks.length || retrieval.entities.length || retrieval.events.length || retrieval.anomalies.length
        ? `Found structured matches. ${summary}`
        : 'No matching chunks or structured findings found in Surreal index.';
      appendChatLog(cacheId, chatId, { role: 'user', mode, queryStrategy, content: question });
      appendChatLog(cacheId, chatId, { role: 'assistant', mode, queryStrategy, content: answer, evidenceCount: chunks.length });
      logServer('query:done', { cacheId, mode, chatId, evidenceCount: chunks.length, structured: summary });
      return res.json({
        ok: true,
        mode,
        chatId,
        answer,
        evidence: chunks,
        structured: {
          entities: retrieval.entities,
          events: retrieval.events,
          anomalies: retrieval.anomalies,
          relations: retrieval.relations
        }
      });
    }

    const apiKey = String(req.body?.openRouterKey || '').trim();
    const model = String(req.body?.model || '').trim() || 'openai/gpt-4o-mini';
    if (!apiKey) return res.status(400).json({ ok: false, error: 'OpenRouter key required for ai mode.' });

    const prior = readChatLog(cacheId, chatId).messages || [];
    const priorTurns = prior.slice(-8).map((m) => `${m.role?.toUpperCase?.() || 'MSG'}: ${String(m.content || '').slice(0, 220)}`).join('\n');
    const prompt = `You are an investigation assistant. Answer using only supplied evidence snippets and structured findings.
Query strategy: ${queryStrategy}${queryStrategyNotes ? ` (${queryStrategyNotes})` : ''}
Prior context:
${priorTurns || 'none'}
Question: ${question}

Chunk Evidence:
${chunks.map((c, i) => `#${i + 1} ${c.filename} [chunk ${c.chunkIndex}] score=${c.score}
${c.text.slice(0, 1200)}`).join('\n\n')}

Structured Findings:
Entities: ${JSON.stringify(retrieval.entities.slice(0, 12))}
Events: ${JSON.stringify(retrieval.events.slice(0, 12))}
Anomalies: ${JSON.stringify(retrieval.anomalies.slice(0, 10))}
Relations: ${JSON.stringify(retrieval.relations.slice(0, 10))}

Return:
1) direct answer
2) key links/patterns
3) possible vulnerabilities or mismatches
4) confidence (low/medium/high) with why.`;
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.1 })
    });
    const j = await r.json();
    const answer = j?.choices?.[0]?.message?.content || 'No AI answer returned.';

    appendChatLog(cacheId, chatId, { role: 'user', mode, queryStrategy, content: question });
    appendChatLog(cacheId, chatId, { role: 'assistant', mode, queryStrategy, content: answer, evidenceCount: chunks.length });
    logServer('query:done', { cacheId, mode, chatId, evidenceCount: chunks.length });

    return res.json({
      ok: true,
      mode,
      chatId,
      answer,
      evidence: chunks,
      structured: {
        entities: retrieval.entities,
        events: retrieval.events,
        anomalies: retrieval.anomalies,
        relations: retrieval.relations
      }
    });
  } catch (error) {
    logServer('query:error', { cacheId, mode, chatId, error: error.message });
    return res.status(500).json({ ok: false, error: error.message || 'query failed' });
  }
});

app.post('/api/index/strategy-suggest/:cacheId', async (req, res) => {
  const cacheId = String(req.params.cacheId || '').trim();
  const mode = String(req.body?.mode || 'heuristic').trim();
  const data = readCaches();
  const cache = findCache(data, cacheId);
  if (!cache) return res.status(404).json({ ok: false, error: 'cache not found' });

  const files = (cache.files || []).slice(0, 8);
  const extCounts = {};
  for (const f of files) {
    const ext = String((f.originalName || '').split('.').pop() || '').toLowerCase();
    extCounts[ext] = (extCounts[ext] || 0) + 1;
  }
  const heuristic = {
    strategy: 'entity-relationship-timeline',
    rationale: `Detected ${files.length} sample files. Prioritize people/org extraction, money terms, and timeline events.`,
    focus: ['people', 'organizations', 'money transfers', 'dates/timeline', 'communications metadata'],
    extCounts
  };

  if (mode !== 'ai') return res.json({ ok: true, source: 'heuristic', ...heuristic });

  const key = String(req.body?.openRouterKey || '').trim();
  const model = String(req.body?.model || '').trim() || 'openai/gpt-4o-mini';
  if (!key) return res.json({ ok: true, source: 'heuristic-no-key', ...heuristic });

  try {
    const prompt = `Suggest an indexing strategy for investigation data.
Files:\n${files.map((f) => `- ${f.originalName} (${f.size} bytes)`).join('\n')}
Return JSON with keys: strategy, rationale, focus(array).`;
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.2 })
    });
    const j = await r.json();
    const raw = String(j?.choices?.[0]?.message?.content || '').trim();
    let parsed = null;
    try { parsed = JSON.parse(raw.replace(/^```json/i, '').replace(/```$/i, '').trim()); } catch {}
    if (parsed?.strategy) return res.json({ ok: true, source: 'ai', ...parsed, extCounts });
    return res.json({ ok: true, source: 'heuristic-fallback', ...heuristic, aiRaw: raw.slice(0, 600) });
  } catch {
    return res.json({ ok: true, source: 'heuristic-error-fallback', ...heuristic });
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
