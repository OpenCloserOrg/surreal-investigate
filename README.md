# Surreal Investigate

Local-first **SurrealDB + Node.js** investigation app.

When fully running, you can:
1. Create a cache (case bucket)
2. Upload files (or load sample fixture)
3. Index into SurrealDB
4. See **Ready for questions**
5. Ask in either:
   - **Surreal only** (no LLM cost)
   - **Surreal + AI** (OpenRouter)

## Current implemented features

- `npm install` + `npm start` on `http://localhost:3000`
- Cache CRUD (create/list)
- File upload queue and support preview
- Supported extraction now: `.txt .md .csv .json .eml .sql .pdf .docx .xlsx .xls .doc .epub`
- Unknown extensions: best-effort raw text fallback extraction
- Surreal indexing endpoint
- Index logs + readiness state
- Query endpoint with two modes:
  - Surreal keyword/BM25 retrieval
  - Surreal retrieval + OpenRouter synthesis
- OpenRouter key/model local storage
- OpenRouter ping health check (green/red)
- Manifest persistence:
  - `indexes/<cache-id>/manifest.json`
  - `indexes/<cache-id>/snapshots/<timestamp>.json`
- Sample fixture for flow testing: `fixtures/sample-case-500w.txt`

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

> If your `surreal` binary is in `~/.local/bin/surreal`, use that full path.

---

## Run

```bash
npm install
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
```

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
- `GET /api/caches`
- `POST /api/caches`
- `POST /api/upload`
- `POST /api/index/:cacheId`
- `POST /api/query/:cacheId`
- `POST /api/openrouter/ping`

---

## Project structure

```txt
surreal-investigate/
  lib/
    surreal.js
    extract.js
  fixtures/
    sample-case-500w.txt
  public/
    index.html
    app.js
    styles.css
  uploads/
  indexes/
  data/
  server.js
```

---

## Next planned upgrades

- Add `.docx .xlsx .pdf` extraction adapters
- Better entity/relation extraction into dedicated tables
- Query timeline visualization and relationship map
- Background job queue for very large imports
- Render deploy profile and health checks
