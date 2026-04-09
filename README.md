# Surreal Investigate

A local-first **SurrealDB + Node.js** investigation workspace for large document dumps (emails, spreadsheets, docs, txt, etc.).

Goal: make forensic-style investigation intuitive:
- ingest files in batches (“caches” / case sets)
- extract + normalize text
- index into SurrealDB
- ask questions in either:
  - **Surreal-only mode** (no LLM cost)
  - **Surreal + AI mode** (OpenRouter-backed synthesis)

---

## Current status

This repo is in active build-out.

### Implemented now

- README baseline ✅
- Node app scaffold ✅
- `npm install` + `npm start` + UI on `http://localhost:3000` ✅
- Cache creation API + local metadata persistence (`.app/caches.json`) ✅
- Multi-file upload API (`/api/upload`) + per-cache storage in `uploads/<cache-id>/` ✅
- File preview table in UI (name, size, extension, supported status) ✅
- OpenRouter key/model local storage UI + simple status dot ✅
- Smoke test (`npm test`) for health endpoint ✅

### Build sequence (incremental pushes)

1. **README + architecture baseline** ✅
2. **App scaffold (Node server + UI + upload queue)** ✅
3. File extraction pipeline (type support + conversion to text)
4. SurrealDB schema + indexing workers
5. Query console (Surreal-only / Surreal+AI toggle)
6. Cache management (append files, re-index, preserve snapshots)
7. Persistence polish + deploy docs + tests

---

## Product requirements (target behavior)

- `npm install` + `npm start` should run locally.
- App opens on `http://localhost:3000`.
- UI supports selecting/uploading many files.
- Each file shows:
  - name
  - size
  - detected type
  - supported/unsupported status
- Files can be grouped into named **caches** (investigation sets).
- Caches can be expanded with additional files and re-indexed without losing old snapshots.
- Index artifacts persist to local folders (and survive restart).
- System shows “**Ready for questions**” once index build completes.
- Query mode toggle:
  - **Surreal-only**
  - **Surreal + AI**
- OpenRouter key + model can be entered in UI and saved locally (browser localStorage).
- OpenRouter health check includes red/green indicator.
- During long operations, UI shows step-by-step loading messages explaining what is happening.

---

## Planned architecture

## Runtime
- Node.js server (Express)
- SurrealDB Node SDK (`surrealdb`)
- Local filesystem persistence for uploads/index manifests

## Storage layout (planned)

```txt
surreal-investigate/
  data/
    surreal/                # Surreal file DB or runtime metadata
  uploads/
    <cache-id>/             # original uploaded files
  indexes/
    <cache-id>/
      manifest.json         # index metadata + schema version + stats
      snapshots/
        <timestamp>.json    # reindex history checkpoints
```

## Surreal schema (v1 planned)

- `cache` — investigation case set
- `document` — uploaded file metadata
- `chunk` — extracted text chunks for retrieval
- `entity` — normalized people/org/phone/email/account references
- `relation` — links between entities/documents/chunks
- `event` — temporal/financial/communication events

---

## Local run (target)

```bash
npm install
npm start
```

Then open:

- `http://localhost:3000`

---

## Configuration (planned)

Environment variables:

- `PORT` (default `3000`)
- `SURREAL_URL` (default local)
- `SURREAL_NS`
- `SURREAL_DB`
- `SURREAL_USER`
- `SURREAL_PASS`
- `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`)

Note: OpenRouter API key will be user-entered in UI and stored in local browser storage by default for convenience.

---

## Query modes

### 1) Surreal-only (no AI)

- Runs direct retrieval + graph traversal + deterministic summaries.
- Best for:
  - low cost
  - strict reproducibility
  - quick evidence lookup

### 2) Surreal + AI

- Retrieves candidates from Surreal first.
- Sends grounded evidence to model for synthesis.
- Returns answer + source trace.

---

## Deployment notes (planned)

### Render (primary deployment target)

- Native fit for long-running Node server + background indexing.

### Netlify (secondary)

- Possible via Functions/adapter path, but not ideal for heavy ingest/index workloads.
- README will include exact constraints and adapter setup if needed.

---

## Testing strategy (planned)

- Unit tests: parsers/chunking/entity normalization
- Integration tests: upload → extract → index → query pipeline
- Smoke tests: startup + OpenRouter health check + Surreal connectivity
- Fixture-based tests for `.txt`, `.csv`, `.eml`, `.docx`, `.xlsx`, `.pdf`

---

## Near-term roadmap

1. Scaffold app (`server/`, `public/`, `lib/`, `workers/`)
2. Build upload queue + file inspector UI
3. Implement extractor adapters (start with txt/csv/json/md)
4. Wire Surreal writes and index manifests
5. Add query console + mode toggle + readiness state
6. Add OpenRouter key/model panel + health dot

---

## License

TBD
