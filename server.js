import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import os from 'os';
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
const INDEX_JOB_TIMEOUT_MS = Number(process.env.INDEX_JOB_TIMEOUT_MS || 20 * 60 * 1000);
const indexJobs = new Map();
const DEFAULT_INDEX_OPTIONS = {
  chunkSize: 1400,
  parallelWorkers: 1,
  analysisEnabled: true,
  preferGpu: false
};

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

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeIndexOptions(input = {}) {
  return {
    chunkSize: clampInt(input.chunkSize, 300, 8000, DEFAULT_INDEX_OPTIONS.chunkSize),
    parallelWorkers: clampInt(input.parallelWorkers, 1, 24, DEFAULT_INDEX_OPTIONS.parallelWorkers),
    analysisEnabled: input.analysisEnabled !== false,
    preferGpu: Boolean(input.preferGpu)
  };
}

function computeSystemProfile() {
  const cpuCount = Array.isArray(os.cpus()) ? os.cpus().length : 1;
  const totalMemBytes = os.totalmem();
  const freeMemBytes = os.freemem();
  const availableMemGb = Number((freeMemBytes / (1024 ** 3)).toFixed(1));
  const safeWorkersByCpu = Math.max(1, Math.floor(cpuCount * 0.75));
  const safeWorkersByRam = Math.max(1, Math.floor(availableMemGb / 1.25));
  const recommendedWorkers = Math.max(1, Math.min(16, safeWorkersByCpu, safeWorkersByRam));
  const recommendedChunkSize = availableMemGb >= 16 ? 2600 : availableMemGb >= 8 ? 2000 : 1400;
  return {
    cpuCount,
    totalMemBytes,
    freeMemBytes,
    availableMemGb,
    loadAvg: os.loadavg(),
    recommended: {
      parallelWorkers: recommendedWorkers,
      chunkSize: recommendedChunkSize,
      analysisEnabled: true,
      preferGpu: false
    }
  };
}

async function mapLimit(items, limit, worker) {
  const out = [];
  let i = 0;
  const slots = Array.from({ length: Math.max(1, limit) }, async () => {
    while (i < items.length) {
      const current = i;
      i += 1;
      out[current] = await worker(items[current], current);
    }
  });
  await Promise.all(slots);
  return out;
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
app.get('/api/system-profile', (_req, res) => res.json({ ok: true, system: computeSystemProfile() }));
app.get('/api/index-recommendation/:cacheId', (req, res) => {
  const cacheId = String(req.params.cacheId || '').trim();
  const data = readCaches();
  const cache = findCache(data, cacheId);
  if (!cache) return res.status(404).json({ ok: false, error: 'cache not found' });

  const totalBytes = (cache.files || []).reduce((sum, f) => sum + (Number(f.size) || 0), 0);
  const system = computeSystemProfile();
  const recommended = normalizeIndexOptions(system.recommended);
  const baseline = cache.indexPerformance?.bytesPerSec || 38 * 1024;
  const baselineWorkers = cache.indexPerformance?.indexOptions?.parallelWorkers || 1;
  const workerBoost = Math.max(1, Math.min(4.5, recommended.parallelWorkers / baselineWorkers));
  const chunkBoost = recommended.chunkSize > 1400 ? 1.18 : 1;
  const predictedBytesPerSec = Math.floor(baseline * workerBoost * chunkBoost);
  const currentEtaSec = Math.ceil(totalBytes / Math.max(1, baseline));
  const predictedEtaSec = Math.ceil(totalBytes / Math.max(1, predictedBytesPerSec));
  const savedSec = Math.max(0, currentEtaSec - predictedEtaSec);
  const savedPct = currentEtaSec > 0 ? Math.round((savedSec / currentEtaSec) * 100) : 0;

  return res.json({
    ok: true,
    cacheId,
    totalBytes,
    system,
    recommended,
    estimate: { baselineBytesPerSec: baseline, predictedBytesPerSec, currentEtaSec, predictedEtaSec, savedSec, savedPct },
    rationale: [
      `Use up to ${recommended.parallelWorkers} workers from CPU(${system.cpuCount}) + free RAM(${system.availableMemGb}GB).`,
      `Chunk size ${recommended.chunkSize} lowers per-chunk overhead for larger datasets.`,
      'GPU preference is exposed for future support; current pipeline is CPU + I/O bound.'
    ]
  });
});

app.get('/api/caches', (_req, res) => res.json({ ok: true, caches: readCaches().caches || [] }));
app.get('/api/index-progress/:cacheId', (req, res) => {
  const cacheId = String(req.params.cacheId || '').trim();
  const job = indexJobs.get(cacheId);
  if (!job) return res.json({ ok: true, active: false });
  const elapsedSec = Math.max(1, Math.floor((Date.now() - job.startedAtMs) / 1000));
  const bytesPerSec = Math.max(1, Math.floor(job.processedBytes / elapsedSec));
  const remainingBytes = Math.max(0, job.totalBytes - job.processedBytes);
  let etaSec = Math.ceil(remainingBytes / bytesPerSec);
  if (job.totalFiles > 0 && job.processedFiles > 0) {
    const avgPerFile = elapsedSec / job.processedFiles;
    const etaByFiles = Math.ceil((job.totalFiles - job.processedFiles) * avgPerFile);
    etaSec = Math.min(etaSec, etaByFiles);
  }
  etaSec = Math.min(etaSec, 60 * 60); // clamp to avoid absurd ETAs on tiny datasets
  const pct = job.totalBytes > 0 ? Math.min(100, Math.round((job.processedBytes / job.totalBytes) * 100)) : 0;
  return res.json({
    ok: true,
    active: job.status === 'running',
    status: job.status,
    stage: job.stage || '',
    cacheId,
    totalFiles: job.totalFiles,
    processedFiles: job.processedFiles,
    totalBytes: job.totalBytes,
    processedBytes: job.processedBytes,
    currentFile: job.currentFile || '',
    elapsedSec,
    bytesPerSec,
    etaSec,
    pct,
    indexOptions: job.indexOptions || DEFAULT_INDEX_OPTIONS
  });
});
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
  const forceReindex = Boolean(req.body?.forceReindex);
  const indexStrategy = String(req.body?.indexStrategy || '').trim() || 'balanced';
  const indexStrategyNotes = String(req.body?.indexStrategyNotes || '').trim();
  const indexOptions = normalizeIndexOptions(req.body?.indexOptions || {});
  const data = readCaches();
  const cache = findCache(data, cacheId);
  if (!cache) return res.status(404).json({ ok: false, error: 'cache not found' });
  const logs = [];
  const log = (m) => logs.push({ at: new Date().toISOString(), message: m });

  if (!forceReindex && cache.readyForQuestions && cache.indexStats) {
    const manifestPath = path.join(INDEXES_DIR, cacheId, 'manifest.json');
    const manifest = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      : {
          cacheId,
          indexedAt: cache.updatedAt || new Date().toISOString(),
          status: 'ready',
          strategy: { name: indexStrategy, notes: indexStrategyNotes },
          options: cache.indexPerformance?.indexOptions || DEFAULT_INDEX_OPTIONS,
          stats: cache.indexStats,
          logs: [{ at: new Date().toISOString(), message: 'Loaded existing index without re-scanning files.' }]
        };
    return res.json({ ok: true, cache, manifest, reusedExisting: true });
  }

  try {
    const preFiles = (cache.files || []).filter((f) => f.absPath && fs.existsSync(f.absPath));
    indexJobs.set(cacheId, {
      status: 'running',
      startedAtMs: Date.now(),
      totalFiles: preFiles.length,
      processedFiles: 0,
      totalBytes: preFiles.reduce((s, f) => s + (Number(f.size) || 0), 0),
      processedBytes: 0,
      currentFile: '',
      stage: 'initializing',
      indexOptions
    });

    logServer('index:start', { cacheId, indexStrategy, indexStrategyNotes: indexStrategyNotes.slice(0, 180) });
    const startJob = indexJobs.get(cacheId); if (startJob) { startJob.stage = 'connecting_to_surreal'; indexJobs.set(cacheId, startJob); }
    log(`Index strategy: ${indexStrategy}${indexStrategyNotes ? ` (${indexStrategyNotes.slice(0, 120)})` : ''}`);
    log(`Tuning: chunkSize=${indexOptions.chunkSize}, workers=${indexOptions.parallelWorkers}, analysis=${indexOptions.analysisEnabled ? 'on' : 'off'}, gpuPref=${indexOptions.preferGpu ? 'on' : 'off (cpu mode)'}`);
    log('Connecting to SurrealDB...');
    await withTimeout(withSurreal(async (db) => db.query('RETURN 1;')), 5000, 'surreal precheck');
    const result = await withTimeout(withSurreal(async (db) => {
      await ensureSchema(db);
      const schemaJob = indexJobs.get(cacheId); if (schemaJob) { schemaJob.stage = 'ensuring_schema'; indexJobs.set(cacheId, schemaJob); }
      log('Schema ensured.');
      await db.query(
        'DELETE document WHERE cacheId = $cacheId; DELETE chunk WHERE cacheId = $cacheId; DELETE entity WHERE cacheId = $cacheId; DELETE event WHERE cacheId = $cacheId; DELETE activity WHERE cacheId = $cacheId; DELETE intent WHERE cacheId = $cacheId; DELETE relation WHERE cacheId = $cacheId; DELETE anomaly WHERE cacheId = $cacheId;',
        { cacheId }
      );
      log('Previous index rows for cache cleared (documents, chunks, entities, events, activities, intents, relations, anomalies).');

      const allFiles = cache.files || [];
      const files = allFiles.filter((f) => f.absPath && fs.existsSync(f.absPath));
      log(`Cache has ${allFiles.length} file records; ${files.length} files currently readable from disk.`);
      let documentCount = 0;
      let chunkCount = 0;
      let entityCount = 0;
      let eventCount = 0;
      let activityCount = 0;
      let intentCount = 0;
      let relationCount = 0;
      let anomalyCount = 0;

      for (const file of files) {
        let fileStartProcessedBytes = 0;
        const job = indexJobs.get(cacheId);
        if (job) {
          job.currentFile = file.originalName;
          job.stage = 'extracting_file';
          fileStartProcessedBytes = job.processedBytes || 0;
          indexJobs.set(cacheId, job);
        }
        log(`Starting extraction: ${file.originalName} (${Math.round((Number(file.size)||0)/1024)} KB)`);
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
        const chunks = chunkText(extracted.text, indexOptions.chunkSize);
        const chunkJob = indexJobs.get(cacheId); if (chunkJob) { chunkJob.stage = 'indexing_chunks'; indexJobs.set(cacheId, chunkJob); }
        log(`Chunking ${file.originalName}: ${chunks.length} chunks`);
        await mapLimit(chunks, indexOptions.parallelWorkers, async (text, idx) => {
          const i = idx + 1;
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

          // Incremental progress for large single-file jobs.
          const liveJob = indexJobs.get(cacheId);
          if (liveJob && chunks.length > 0) {
            const perChunkBytes = (Number(file.size) || 0) / chunks.length;
            const baseProcessed = liveJob.processedBytes;
            const target = Math.min(liveJob.totalBytes, Math.floor(fileStartProcessedBytes + (i * perChunkBytes)));
            if (target > baseProcessed) {
              liveJob.processedBytes = target;
              indexJobs.set(cacheId, liveJob);
            }
          }

          if (indexOptions.analysisEnabled) {
            const analysis = analyzeChunk(text);
            for (const entity of analysis.entities) {
              await db.query('INSERT INTO entity $data;', { data: { cacheId, fileId: file.id, filename: file.originalName, chunkIndex: i, ...entity } });
              entityCount += 1;
            }
            for (const ev of analysis.events) {
              await db.query('INSERT INTO event $data;', { data: { cacheId, fileId: file.id, filename: file.originalName, chunkIndex: i, ...ev } });
              eventCount += 1;
            }
            for (const act of (analysis.activities || [])) {
              await db.query('INSERT INTO activity $data;', { data: { cacheId, fileId: file.id, filename: file.originalName, chunkIndex: i, ...act } });
              activityCount += 1;
            }
            for (const intent of (analysis.intents || [])) {
              await db.query('INSERT INTO intent $data;', { data: { cacheId, fileId: file.id, filename: file.originalName, chunkIndex: i, ...intent } });
              intentCount += 1;
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
        });
        log(`Indexed ${file.originalName}: ${summary.wordCount} words, ${chunks.length} chunks, entities=${entityCount}, events=${eventCount}, activities=${activityCount}, intents=${intentCount}, anomalies=${anomalyCount} (method: ${extracted.method || 'unknown'}).`);
        const job2 = indexJobs.get(cacheId);
        if (job2) {
          job2.processedFiles += 1;
          job2.processedBytes += Number(file.size) || 0;
          indexJobs.set(cacheId, job2);
        }
      }

      return { documentCount, chunkCount, entityCount, eventCount, activityCount, intentCount, relationCount, anomalyCount };
    }), INDEX_JOB_TIMEOUT_MS, 'index job');

    let quickSummary = `Indexed ${result.documentCount} document(s) into ${result.chunkCount} chunk(s).`;
    const sumJob = indexJobs.get(cacheId); if (sumJob) { sumJob.stage = 'building_summary'; indexJobs.set(cacheId, sumJob); }
    try {
      const summaryRows = await withTimeout(withSurreal(async (db) => {
        const [ent, ev, an] = await Promise.all([
          db.query('SELECT * FROM entity WHERE cacheId = $cacheId LIMIT 5;', { cacheId }),
          db.query('SELECT * FROM event WHERE cacheId = $cacheId LIMIT 5;', { cacheId }),
          db.query('SELECT * FROM anomaly WHERE cacheId = $cacheId LIMIT 5;', { cacheId })
        ]);
        const rowsToList = (rows) => (Array.isArray(rows?.[0]) ? rows[0] : (rows?.[0]?.result || []));
        return { entities: rowsToList(ent), events: rowsToList(ev), anomalies: rowsToList(an) };
      }), 8000, 'post-index-summary');

      quickSummary = [
        `Indexed ${result.documentCount} document(s) into ${result.chunkCount} chunk(s).`,
        summaryRows.entities.length ? `Top entities: ${summaryRows.entities.map((e) => e.value || e.normalized).filter(Boolean).slice(0, 3).join(', ')}.` : 'No strong named entities extracted yet.',
        (summaryRows.events.length || summaryRows.anomalies.length)
          ? `Signals: ${summaryRows.events.length} event(s), ${summaryRows.anomalies.length} anomaly flag(s).`
          : 'No event/anomaly signals extracted yet.'
      ].join(' ');
    } catch (summaryErr) {
      log(`Summary generation skipped: ${summaryErr.message}`);
    }

    const manifest = {
      cacheId,
      indexedAt: new Date().toISOString(),
      status: 'ready',
      strategy: { name: indexStrategy, notes: indexStrategyNotes },
      options: indexOptions,
      indexingExplanation: [
        '1) Extract readable text from each file.',
        '2) Create document metadata rows (filename, size, word counts).',
        '3) Split text into chunks and store chunk rows for retrieval.',
        '4) Derive structured intelligence per chunk: entities, events, anomalies, and co-occurrence relations.',
        '5) Query combines lexical chunk retrieval with structured tables for investigative patterning.'
      ],
      stats: result,
      summary: quickSummary,
      logs
    };
    writeManifest(cacheId, manifest);

    cache.status = 'indexed';
    cache.readyForQuestions = true;
    cache.updatedAt = new Date().toISOString();
    cache.indexStats = result;
    const finishedJob = indexJobs.get(cacheId);
    const durationSec = Math.max(1, Math.round((Date.now() - (finishedJob?.startedAtMs || Date.now())) / 1000));
    const totalBytes = (cache.files || []).reduce((sum, f) => sum + (Number(f.size) || 0), 0);
    cache.indexPerformance = {
      durationSec,
      totalBytes,
      bytesPerSec: Math.floor(totalBytes / durationSec),
      indexedAt: new Date().toISOString(),
      indexOptions
    };
    cache.lastSummary = quickSummary;
    writeCaches(data);
    const doneJob = indexJobs.get(cacheId);
    if (doneJob) {
      doneJob.status = 'done';
      doneJob.stage = 'done';
      doneJob.currentFile = '';
      doneJob.processedFiles = doneJob.totalFiles;
      doneJob.processedBytes = doneJob.totalBytes;
      indexJobs.set(cacheId, doneJob);
    }
    logServer('index:done', { cacheId, ...result });

    return res.json({ ok: true, cache, manifest });
  } catch (error) {
    cache.status = 'index_error';
    cache.readyForQuestions = false;
    cache.updatedAt = new Date().toISOString();
    writeCaches(data);
    const failedJob = indexJobs.get(cacheId);
    if (failedJob) {
      failedJob.status = 'error';
      failedJob.stage = 'error';
      indexJobs.set(cacheId, failedJob);
    }
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

  const trace = [];
  const pushTrace = (step, detail = {}) => trace.push({ at: new Date().toISOString(), step, ...detail });

  try {
    logServer('query:start', { cacheId, mode, chatId, queryStrategy });
    pushTrace('parse_query', {
      explanation: 'Normalize user input and build query execution plan (mode/strategy/chat context) before retrieval.',
      mode,
      queryStrategy,
      questionLength: question.length,
      questionPreview: question.slice(0, 180)
    });
    await withTimeout(withSurreal(async (db) => db.query('RETURN 1;')), 5000, 'surreal precheck');
    pushTrace('surreal_precheck_ok', {
      explanation: 'Ping SurrealDB first to verify connectivity before running retrieval queries.',
      request: { query: 'RETURN 1;' },
      response: { ok: true }
    });
    const retrieval = await withTimeout(withSurreal(async (db) => {
      const chunkQuery = `SELECT fileId, filename, chunkIndex, text FROM chunk WHERE cacheId = $cacheId LIMIT 3000;`;
      const [chunkRows, entityRows, eventRows, activityRows, intentRows, anomalyRows, relationRows] = await Promise.all([
        db.query(chunkQuery, { cacheId }),
        db.query(`SELECT type, value, normalized, filename, chunkIndex, confidence FROM entity WHERE cacheId = $cacheId LIMIT 3000;`, { cacheId }),
        db.query(`SELECT type, amount, currency, rawAmount, dates, filename, chunkIndex, confidence FROM event WHERE cacheId = $cacheId LIMIT 3000;`, { cacheId }),
        db.query(`SELECT type, actor, action, locations, dates, filename, chunkIndex, confidence FROM activity WHERE cacheId = $cacheId LIMIT 3000;`, { cacheId }),
        db.query(`SELECT type, confidence, filename, chunkIndex FROM intent WHERE cacheId = $cacheId LIMIT 3000;`, { cacheId }),
        db.query(`SELECT type, severity, rationale, filename, chunkIndex FROM anomaly WHERE cacheId = $cacheId LIMIT 3000;`, { cacheId }),
        db.query(`SELECT type, sourceType, sourceValue, targetType, targetValue, filename, chunkIndex FROM relation WHERE cacheId = $cacheId LIMIT 3000;`, { cacheId })
      ]);

      const rowsToList = (rows) => (Array.isArray(rows?.[0]) ? rows[0] : (rows?.[0]?.result || []));
      const allChunks = rowsToList(chunkRows);
      const allEntities = rowsToList(entityRows);
      const allEvents = rowsToList(eventRows);
      const allActivities = rowsToList(activityRows);
      const allIntents = rowsToList(intentRows);
      const allAnomalies = rowsToList(anomalyRows);
      const allRelations = rowsToList(relationRows);

      const tokens = tokenize(question);
      const scoreText = (txt='') => {
        const v = String(txt || '').toLowerCase();
        let s = 0;
        for (const t of tokens) if (v.includes(t)) s += 1;
        return s;
      };

      let chunks = allChunks
        .map((c) => ({ ...c, score: scoreText(c.text) }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      if (!chunks.length && allChunks.length) {
        chunks = allChunks.slice(0, 3).map((c) => ({ ...c, score: 0 }));
      }

      const byTokenMatch = (obj) => {
        const v = JSON.stringify(obj).toLowerCase();
        let s = 0;
        for (const t of tokens) if (v.includes(t)) s += 1;
        return s;
      };

      const entities = allEntities.map((e) => ({ ...e, score: byTokenMatch(e) })).filter((e) => e.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
      const events = allEvents.map((e) => ({ ...e, score: byTokenMatch(e) })).filter((e) => e.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
      const activities = allActivities.map((a) => ({ ...a, score: byTokenMatch(a) })).filter((a) => a.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
      const intents = allIntents.map((i) => ({ ...i, score: byTokenMatch(i) })).filter((i) => i.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);
      const anomalies = allAnomalies.map((a) => ({ ...a, score: byTokenMatch(a) })).filter((a) => a.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);
      const relations = allRelations.map((r) => ({ ...r, score: byTokenMatch(r) })).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);

      return { chunks, entities, events, activities, intents, anomalies, relations, tokenCount: tokens.length };
    }), 20000, 'query');

    const chunks = retrieval.chunks;
    pushTrace('surreal_retrieval_done', {
      explanation: 'Query chunk + structured tables in SurrealDB, then score/rank candidates for response synthesis.',
      request: {
        chunkQuery: 'SELECT fileId, filename, chunkIndex, text FROM chunk WHERE cacheId = $cacheId LIMIT 3000;',
        structuredTables: ['entity', 'event', 'activity', 'intent', 'anomaly', 'relation']
      },
      response: {
        chunks: retrieval.chunks.length,
        entities: retrieval.entities.length,
        events: retrieval.events.length,
        activities: retrieval.activities.length,
        intents: retrieval.intents.length,
        anomalies: retrieval.anomalies.length,
        relations: retrieval.relations.length,
        sampleChunk: retrieval.chunks[0] ? {
          filename: retrieval.chunks[0].filename,
          chunkIndex: retrieval.chunks[0].chunkIndex,
          score: retrieval.chunks[0].score,
          textPreview: String(retrieval.chunks[0].text || '').slice(0, 220)
        } : null
      }
    });

    if (mode === 'surreal') {
      const summary = [
        `Chunks: ${chunks.length}`,
        `Entities: ${retrieval.entities.length}`,
        `Events: ${retrieval.events.length}`,
        `Activities: ${retrieval.activities.length}`,
        `Intents: ${retrieval.intents.length}`,
        `Anomalies: ${retrieval.anomalies.length}`,
        `Relations: ${retrieval.relations.length}`
      ].join(' | ');
      const answer = chunks.length || retrieval.entities.length || retrieval.events.length || retrieval.activities.length || retrieval.intents.length || retrieval.anomalies.length
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
        trace,
        structured: {
          entities: retrieval.entities,
          events: retrieval.events,
          activities: retrieval.activities,
          intents: retrieval.intents,
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
Activities: ${JSON.stringify(retrieval.activities.slice(0, 12))}
Intents: ${JSON.stringify(retrieval.intents.slice(0, 10))}
Anomalies: ${JSON.stringify(retrieval.anomalies.slice(0, 10))}
Relations: ${JSON.stringify(retrieval.relations.slice(0, 10))}

Return:
1) direct answer
2) key connections/patterns
3) notable anomalies or mismatches
4) confidence (low/medium/high) with why.`;
    pushTrace('build_ai_prompt', {
      explanation: 'Compose grounded AI prompt from Surreal retrieval output + recent chat context.',
      request: {
        model,
        promptChars: prompt.length,
        promptPreview: prompt.slice(0, 1200)
      }
    });
    const aiRequestBody = JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.1 });
    pushTrace('openrouter_request_start', {
      explanation: 'Send grounded prompt to OpenRouter chat completions endpoint.',
      model,
      url: 'https://openrouter.ai/api/v1/chat/completions',
      request: {
        payloadBytes: aiRequestBody.length,
        bodyPreview: aiRequestBody.slice(0, 1400)
      }
    });
    pushTrace('openrouter_awaiting_response', { explanation: 'Waiting for model completion from OpenRouter.' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: aiRequestBody,
      signal: controller.signal
    }).finally(() => clearTimeout(timer));
    const j = await r.json();
    if (!r.ok) {
      pushTrace('openrouter_error', { status: r.status, error: j?.error?.message || 'unknown' });
      return res.status(502).json({ ok: false, error: `OpenRouter error: ${j?.error?.message || r.status}`, trace });
    }
    pushTrace('openrouter_response_ok', {
      explanation: 'OpenRouter returned completion payload successfully.',
      response: {
        status: r.status,
        hasChoices: Array.isArray(j?.choices),
        responsePreview: String(j?.choices?.[0]?.message?.content || '').slice(0, 400)
      }
    });
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
      trace,
      structured: {
        entities: retrieval.entities,
        events: retrieval.events,
        activities: retrieval.activities,
        intents: retrieval.intents,
        anomalies: retrieval.anomalies,
        relations: retrieval.relations
      }
    });
  } catch (error) {
    logServer('query:error', { cacheId, mode, chatId, error: error.message });
    pushTrace('query_error', { error: error.message || 'query failed' });
    return res.status(500).json({ ok: false, error: error.message || 'query failed', trace });
  }
});

app.post('/api/index/feature-plans/:cacheId', async (req, res) => {
  const cacheId = String(req.params.cacheId || '').trim();
  const goal = String(req.body?.goal || '').trim() || 'Find patterns, relationships, and anomalies in this dataset';
  const openRouterKey = String(req.body?.openRouterKey || '').trim();
  const model = String(req.body?.model || '').trim() || 'openai/gpt-4o-mini';
  const data = readCaches();
  const cache = findCache(data, cacheId);
  if (!cache) return res.status(404).json({ ok: false, error: 'cache not found' });

  const files = (cache.files || []).filter((f) => f.absPath && fs.existsSync(f.absPath));
  const fileList = files.slice(0, 8).map((f) => `${f.originalName} (${f.size} bytes)`).join('\n');
  let sampleText = '';
  for (const f of files.slice(0, 3)) {
    try {
      const extracted = await extractTextFromFile(f.absPath, f.originalName);
      const words = String(extracted.text || '').split(/\s+/).filter(Boolean).slice(0, 500);
      if (words.length) { sampleText = words.join(' '); break; }
    } catch {}
  }
  const sampleWordCount = sampleText ? sampleText.split(/\s+/).filter(Boolean).length : 0;

  const system = computeSystemProfile();
  const quick = {
    tier: 'Fast',
    name: 'Quick scan',
    explanation: 'Fastest pass for initial orientation and rough retrieval.',
    indexOptions: { chunkSize: 2400, parallelWorkers: Math.max(1, Math.min(8, system.recommended.parallelWorkers + 1)), analysisEnabled: false, preferGpu: false },
    estimatedTime: 'Low',
    tableDesign: ['document', 'chunk'],
    exampleQuestion: `What are the highest-frequency recurring terms related to: ${goal}?`
  };
  const balanced = {
    tier: 'Balanced',
    name: 'Investigation default',
    explanation: 'Good tradeoff between indexing time and relationship discovery.',
    indexOptions: { chunkSize: 1800, parallelWorkers: system.recommended.parallelWorkers, analysisEnabled: true, preferGpu: false },
    estimatedTime: 'Medium',
    tableDesign: ['document', 'chunk', 'entity', 'event', 'relation', 'anomaly'],
    exampleQuestion: `Which entities and events are most correlated with: ${goal}?`
  };
  const hardcore = {
    tier: 'Hardcore',
    name: 'Deep graph',
    explanation: 'Most robust structure for route-clustering and relationship mapping.',
    indexOptions: { chunkSize: 1400, parallelWorkers: Math.max(1, system.recommended.parallelWorkers - 1), analysisEnabled: true, preferGpu: false },
    estimatedTime: 'High',
    tableDesign: ['document', 'chunk', 'entity', 'event', 'activity', 'intent', 'relation', 'anomaly'],
    exampleQuestion: `Show the largest clusters and nearest-neighbor movement correlations for: ${goal}.`
  };
  const heuristicPlans = [quick, balanced, hardcore];

  if (!openRouterKey) return res.json({ ok: true, source: 'heuristic', plans: heuristicPlans, sampleWordCount });

  try {
    const prompt = `You are designing indexing feature plans for a SurrealDB investigative app.
Create exactly 3 options: Fast, Balanced, Hardcore.
User goal: ${goal}
Files:\n${fileList || 'none'}
Data sample (max 500 words):\n${sampleText || 'no sample extracted'}
Return strict JSON array of 3 objects with keys:
- tier (Fast|Balanced|Hardcore)
- name
- explanation
- indexOptions { chunkSize (300-8000), parallelWorkers (1-24), analysisEnabled (bool), preferGpu (bool) }
- estimatedTime (Low|Medium|High)
- tableDesign (array of table names/features)
- exampleQuestion
Make options meaningfully different and practical.`;

    const aiResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openRouterKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.2 })
    });
    const aiJson = await aiResp.json();
    const raw = String(aiJson?.choices?.[0]?.message?.content || '').trim();
    let parsed = null;
    try { parsed = JSON.parse(raw.replace(/^```json/i, '').replace(/```$/i, '').trim()); } catch {}
    if (Array.isArray(parsed) && parsed.length >= 3) {
      const cleaned = parsed.slice(0, 3).map((p) => ({
        tier: String(p.tier || ''),
        name: String(p.name || ''),
        explanation: String(p.explanation || ''),
        indexOptions: normalizeIndexOptions(p.indexOptions || {}),
        estimatedTime: String(p.estimatedTime || 'Medium'),
        tableDesign: Array.isArray(p.tableDesign) ? p.tableDesign.map((x) => String(x)).slice(0, 12) : [],
        exampleQuestion: String(p.exampleQuestion || '')
      }));
      return res.json({ ok: true, source: 'ai', plans: cleaned, sampleWordCount });
    }
    return res.json({ ok: true, source: 'heuristic-fallback', plans: heuristicPlans, sampleWordCount });
  } catch {
    return res.json({ ok: true, source: 'heuristic-error-fallback', plans: heuristicPlans, sampleWordCount });
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

app.post('/api/suggest-questions/:cacheId', async (req, res) => {
  const cacheId = String(req.params.cacheId || '').trim();
  const chatId = String(req.body?.chatId || '').trim();
  const mode = String(req.body?.mode || 'heuristic');
  const model = String(req.body?.model || '').trim() || 'openai/gpt-4o-mini';
  const openRouterKey = String(req.body?.openRouterKey || '').trim();

  try {
    const retrieval = await withTimeout(withSurreal(async (db) => {
      const [entityRows, eventRows, activityRows, anomalyRows] = await Promise.all([
        db.query(`SELECT * FROM entity WHERE cacheId = $cacheId LIMIT 80;`, { cacheId }),
        db.query(`SELECT * FROM event WHERE cacheId = $cacheId LIMIT 80;`, { cacheId }),
        db.query(`SELECT * FROM activity WHERE cacheId = $cacheId LIMIT 80;`, { cacheId }),
        db.query(`SELECT * FROM anomaly WHERE cacheId = $cacheId LIMIT 80;`, { cacheId })
      ]);
      const rowsToList = (rows) => (Array.isArray(rows?.[0]) ? rows[0] : (rows?.[0]?.result || []));
      return {
        entities: rowsToList(entityRows),
        events: rowsToList(eventRows),
        activities: rowsToList(activityRows),
        anomalies: rowsToList(anomalyRows)
      };
    }), 10000, 'suggestions');

    const names = retrieval.entities.filter((e) => e.type === 'person').slice(0, 4).map((e) => e.value);
    const orgs = retrieval.entities.filter((e) => e.type === 'organization').slice(0, 4).map((e) => e.value);
    const topAn = retrieval.anomalies.slice(0, 3).map((a) => a.type);
    const suggestions = [
      names.length >= 2 ? `Why did ${names[0]} communicate with ${names[1]}?` : null,
      orgs.length ? `What role does ${orgs[0]} play across the dataset?` : null,
      retrieval.events.length ? 'Which money flows look unusual or fragmented?' : null,
      retrieval.activities.length ? 'What is the sequence of key activities over time?' : null,
      topAn.length ? `What evidence supports potential ${topAn[0]} risk?` : null,
      'What major gaps or unknowns remain in this dataset?'
    ].filter(Boolean);

    if (mode !== 'ai' || !openRouterKey) return res.json({ ok: true, source: 'heuristic', suggestions: suggestions.slice(0, 8) });

    const chat = chatId ? readChatLog(cacheId, chatId) : { messages: [] };
    const context = (chat.messages || []).slice(-6).map((m) => `${m.role}: ${String(m.content || '').slice(0, 180)}`).join('\n');
    const prompt = `Generate 6 concise, high-value follow-up investigation questions.
Use this context and discovered signals.
Context:\n${context || 'none'}
People: ${names.join(', ') || 'none'}
Orgs: ${orgs.join(', ') || 'none'}
Anomalies: ${topAn.join(', ') || 'none'}
Return JSON array of strings only.`;

    const aiResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openRouterKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.3 })
    });
    const aiJson = await aiResp.json();
    const raw = String(aiJson?.choices?.[0]?.message?.content || '').trim();
    let parsed = null;
    try { parsed = JSON.parse(raw.replace(/^```json/i, '').replace(/```$/i, '').trim()); } catch {}
    if (Array.isArray(parsed)) return res.json({ ok: true, source: 'ai', suggestions: parsed.slice(0, 8) });
    return res.json({ ok: true, source: 'heuristic-fallback', suggestions: suggestions.slice(0, 8) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'suggestions failed' });
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
