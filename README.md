# Surreal Investigate

<p align="center">
  <img src="images/Surreal-Investigate.jpg" alt="Surreal Investigate logo" width="220" />
</p>

Local-first **SurrealDB + Node.js** data intelligence app for large file collections.

Use it to turn mixed documents/spreadsheets/logs into durable structured memory that AI can query for patterns, correlations, and probability-style insights.

Current AI provider path: **OpenRouter** (single endpoint, multi-model routing for easy model comparisons). More providers (OpenAI/Anthropic/Together/local) are planned.

OpenCLAW operator skill bundle is included under `openclaw/` for agent-driven operation of this project.

When fully running, you can:
1. Create a cache (dataset workspace)
2. Upload files (or load sample fixture)
3. Generate data model + indexing strategy plans (domain extraction mapping + lexicon + table intents)
4. Index into SurrealDB
5. Ask in either:
   - **Surreal only** (no LLM cost)
   - **Surreal + AI** (OpenRouter)

## Current implemented features

- `npm install` + `npm start` on `http://localhost:3000`
- Cache CRUD (create/list)
- File upload queue and support preview
- Supported extraction now: `.txt .md .csv .tsv .json .eml .sql .pdf .docx .xlsx .xls .doc .epub`
- Unknown extensions: best-effort raw text fallback extraction
- Surreal indexing endpoint
- Index logs + readiness state
- Real index progress endpoint with ETA estimates (`/api/index-progress/:cacheId`)
- Load Existing Index path to reuse prior index without re-scanning files
- Query endpoint with two modes:
  - Surreal search mode (term-driven retrieval)
  - Surreal retrieval + OpenRouter synthesis
- Query strategy controls (preset + custom notes)
- Convert natural-language questions to SurrealQL against current cache schema
- View current cache schema (table fields) in-app
- Index strategy controls (preset + custom notes)
- Data model + indexing strategy plan generation (main-topic/comprehensive/all-inclusive) with extraction mapping + lexicon + table write intents
- AI request preview for feature-plan generation (prompt + sampled chunks + payload)
- Chat persistence per cache in `chat-logs/<cache-id>/<chat-id>.json`
- Continue conversations with context from prior turns in each chat
- OpenRouter key/model local storage
- OpenRouter ping health check (green/red)
- Manifest persistence:
  - `indexes/<cache-id>/manifest.json`
  - `indexes/<cache-id>/snapshots/<timestamp>.json`
- Sample fixture for flow testing: `fixtures/sample-case-500w.txt`

## Current working investigation strategy (default)

This project now uses an **investigation-first indexing strategy** by default:

1. Extract text from each file
2. Store document metadata
3. Chunk document text for retrieval
4. Derive structured investigation signals per chunk:
   - **entities** (people, orgs, emails)
   - **events** (e.g., money/transfer-style amounts)
   - **activities** (actions people took: met/called/sent/requested/etc.)
   - **intent signals** (request, urgency, concealment, authorization-style language)
   - **location/time context** (captured where detectable from text patterns)
   - **anomalies** (concealment, threshold splitting, integrity mismatch indicators)
   - **relations** (co-occurrence links between entities)
5. At query time, combine:
   - chunk retrieval
   - structured table retrieval
   - optional AI synthesis grounded in Surreal evidence

This is the current baseline strategy and will be iterated over time (better extraction quality, richer graph logic, stronger anomaly detection).

---

## Prerequisites

- Node 20+
- SurrealDB server running locally (or remote)

### Start Surreal locally (example)

```bash
./scripts-start-surreal.sh
```

Alternative direct command:

```bash
surreal start --user root --pass root --bind 127.0.0.1:8000 file:./data/surreal.db
```

### macOS fallback (recommended if datastore init fails)

If you see datastore load errors on Mac, run this exact sequence:

```bash
cd /path/to/surreal-investigate
mkdir -p data
pkill -f "surreal start" || true
surreal start --user root --pass root --bind 127.0.0.1:8000 "surrealkv://$(pwd)/data/surreal.db"
```

Why this works:
- uses an absolute path via `$(pwd)`
- ensures the `data/` folder exists
- clears stale Surreal processes
- uses `surrealkv://` engine explicitly

> If your `surreal` binary is in `~/.local/bin/surreal`, use that full path.

---

## Run

```bash
npm install
cp .env.example .env   # optional but recommended
npm start
```

Open: `http://localhost:3000`

---

## Environment variables

```bash
PORT=3000
SURREAL_URL=ws://127.0.0.1:8000/rpc
SURREAL_NS=surreal_investigate
SURREAL_DB=main
SURREAL_USER=root
SURREAL_PASS=root
INDEX_JOB_TIMEOUT_MS=1200000
AI_PROVIDER_URL=https://openrouter.ai/api/v1/chat/completions
AI_API_KEY=sk-or-v1-...
AI_MODEL=qwen/qwen3-32b
```

`INDEX_JOB_TIMEOUT_MS` defaults to 20 minutes.
`AI_PROVIDER_URL/AI_API_KEY/AI_MODEL` power secure `.env` credential loading in the UI.

---

## E2E test flow (manual)

1. Create cache (e.g. `harbor-case`)
2. Click **Load Sample File**
3. Click **Create / Refresh Index**
4. Confirm UI shows `Ready for questions ✅`
5. Ask in **Surreal only** mode:
   - `who moved money and through which entities?`
6. (Optional) set OpenRouter key/model and click **Ping**
7. Switch to **Surreal + AI** mode and ask same question.

---

## API endpoints

- `GET /api/health`
- `GET /api/config`
- `GET /api/credentials/env-load`
- `GET /api/caches`
- `POST /api/caches`
- `DELETE /api/cache-file/:cacheId/:fileId`
- `GET /api/chats/:cacheId`
- `POST /api/chats/:cacheId`
- `GET /api/chats/:cacheId/:chatId`
- `POST /api/upload`
- `POST /api/cache-quick-summary/:cacheId`
- `POST /api/index/feature-plans/:cacheId`
- `GET /api/index-recommendation/:cacheId`
- `POST /api/index/:cacheId`
- `GET /api/index-profile/:cacheId`
- `POST /api/index-profile/:cacheId`
- `DELETE /api/index-profile/:cacheId`
- `POST /api/query/:cacheId`
- `POST /api/openrouter/ping`

---

## Project structure

```txt
surreal-investigate/
  lib/
    surreal.js
    extract.js
    investigate.js
  fixtures/
    sample-case-500w.txt
  public/
    index.html
    app.js
    styles.css
  uploads/
  indexes/
  data/
  chat-logs/
  server.js
```

---

## Next planned upgrades

- Add `.docx .xlsx .pdf` extraction adapters
- Better entity/relation extraction into dedicated tables
- Query timeline visualization and relationship map
- Background job queue for very large imports
- Render deploy profile and health checks
