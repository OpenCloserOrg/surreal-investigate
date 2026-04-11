# Surreal Investigate

<p align="center">
  <img src="images/Surreal-Investigate.jpg" alt="Surreal Investigate logo" width="220" />
</p>

Local-first **SurrealDB + Node.js** data intelligence app for large file collections.

Use it to turn mixed documents/spreadsheets/logs into durable structured data that AI can query for patterns, correlations, and probability-style insights.

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
- Data model + indexing strategy plan generation (main-topic/comprehensive/all-inclusive) with extraction mapping + lexicon + suppressions + priority relationships
- AI request preview for planning and outbound provider payload visibility
- Chat persistence per cache in `chat-logs/<cache-id>/<chat-id>.json`
- Continue conversations with context from prior turns in each chat
- OpenRouter key/model local storage + env-credential mode
- OpenRouter ping health check (green/red)
- Query cookbook UI (vector / relationship / time-window / anomaly patterns)
- SurrealQL conversion output panel + copy button
- Schema viewer + indexed-table export download
- OpenCLAW configuration export button + bundled operator skill docs (`openclaw/`)
- Manifest persistence:
  - `indexes/<cache-id>/manifest.json`
  - `indexes/<cache-id>/snapshots/<timestamp>.json`
- Sample fixture for flow testing: `fixtures/sample-case-500w.txt`

## Current working indexing + data model strategy (default)

This project now uses an **indexing-first strategy for operational datasets** (shopper, shipping, and supply-chain heavy data):

1. Extract text from each file (even if source is semi-structured or messy)
2. Store document metadata (source, timestamps, file lineage, confidence)
3. Chunk document text for retrieval
4. Derive structured domain signals per chunk and map them into Surreal tables:
   - **shopper/customer signals** (customer IDs, loyalty IDs, segments, regions)
   - **order + fulfillment signals** (order numbers, SKUs, quantities, status transitions)
   - **shipping + logistics signals** (carrier, tracking number, ship node, route, ETA, delivery exceptions)
   - **supply chain signals** (supplier, PO, warehouse, inventory movement, lead-time changes)
   - **time/location context** (where + when events happened)
   - **anomaly signals** (delay spikes, mismatch indicators, unusual routing, split shipments)
   - **relationships** (cross-table links such as shopper→order, order→shipment, shipment→carrier, SKU→supplier)
5. At query time, combine:
   - lexical/fuzzy retrieval over chunks and indexed fields
   - structured table retrieval over explicit relationships
   - optional AI synthesis grounded in Surreal evidence

This strategy is designed to **structure unstructured data using a clear indexing and data modeling plan**, then support both deterministic lookups and fuzzy search workflows when paired with AI.

### Example relationship patterns (shopper + shipping + supply chain)

- `shopper:123 -> placed -> order:987`
- `order:987 -> contains -> sku:ABC-42`
- `order:987 -> fulfilled_by -> warehouse:NL-AMS-01`
- `order:987 -> shipped_as -> shipment:TRK-4451`
- `shipment:TRK-4451 -> carried_by -> carrier:DHL`
- `sku:ABC-42 -> supplied_by -> supplier:NorthCo`
- `supplier:NorthCo -> delayed -> po:55671`
- `po:55671 -> impacts -> order:987`

These links make it easier to ask questions like:
- "Which shoppers were impacted by supplier delays last week?"
- "Show orders with delivery exceptions and repeated ETA drift."
- "Find likely duplicate/misspelled carrier names (fuzzy matching) before analytics."

### Example relationship patterns (CO2 + agriculture research)

You can run the same flow on scientific and policy-heavy document sets (papers, datasets, reports, policy memos):

- `region:BR-MT -> crop -> soy`
- `study:paper-042 -> measures -> co2_flux`
- `farm-practice:no-till -> affects -> soil_carbon`
- `weather:event-889 -> impacts -> yield:corn`
- `yield:corn -> linked_to -> market:corn-futures`
- `policy:carbon-credit-v2 -> changes -> incentive:adoption`

This enables cross-domain questions such as:
- "Where do CO2 trends and agriculture yield volatility move together?"
- "Which practices appear to reduce emissions while preserving yield?"
- "Do any recurring signals plausibly improve forecast confidence for market participants?"

### Why data modeling matters in SurrealDB

Surreal works best when you keep both:
1. **raw evidence** (`document`, `chunk`) for traceability
2. **modeled structure** (`entity`, `event`, `relation`, domain tables) for fast, explainable queries

That dual structure gives you:
- deterministic filtering (IDs, ranges, timestamps, status values)
- graph-style traversal (who/what affects what)
- fuzzy retrieval over noisy text + variant labels
- AI synthesis grounded in records you can inspect and export

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

## Full UI flow (from 10 uploaded files to answers + exports)

1. **Start system + app**
   - Start SurrealDB
   - Run `npm start` and open `http://localhost:3000`

2. **Create a cache (workspace for one dataset)**
   - Example cache: `co2-agri-q2`
   - Think of cache as your project folder inside the app (files + schema + chats + index artifacts)

3. **Select AI model early (recommended)**
   - In Settings, set OpenRouter key + model (for example: `qwen/qwen3-32b`)
   - Click **Ping** to validate connectivity
   - Why early: the same model can assist quick-summary, strategy planning, and AI query mode consistently

4. **Upload files (example: 10 files)**
   - Mix of `.pdf`, `.csv`, `.xlsx`, `.md`, `.txt`, etc.
   - You can also load fixture files for test flow
   - App extracts text and keeps file provenance in cache metadata

5. **Generate quick summary (recommended)**
   - Run quick summary to detect likely dataset recipe/context
   - This helps pre-bias feature-plan generation toward the right domain assumptions

6. **Generate 3 Data Model + Indexing Strategy Plans**
   - **Main topic focus**
     - Fastest path to topical orientation
     - Tables are lighter (document/chunk/keyword focus)
     - Best when you need quick signal discovery
   - **Comprehensive**
     - Balanced default for most real work
     - Adds richer structure (`entity`, `event`, `relation`, `anomaly`)
     - Good tradeoff of speed vs depth
   - **All-inclusive**
     - Highest-coverage graph extraction
     - Adds activity/intent/cluster-style layers
     - Best for dense investigations and complex correlation work

7. **Tune index performance for your machine ("person computer")**
   - Set **Chunk size** (larger chunks = less overhead, lower precision granularity)
   - Set **Parallel workers** (more workers = faster ingest, higher CPU/RAM pressure)
   - Use index recommendation guidance to scale safely by CPU cores + available memory
   - For very large corpora, run in batches per cache and keep workers near recommended values to avoid thrash

8. **Run Create / Refresh Index**
   - Pipeline writes raw + structured records into SurrealDB
   - Monitor progress using index progress endpoint / UI ETA
   - Wait for `Ready for questions ✅`

9. **Inspect schema + query pathing**
   - Open schema viewer to confirm extracted table/field shape
   - Optional: use SurrealQL conversion panel for NL→SurrealQL drafting

10. **Query without AI (Surreal only)**
   - Best for deterministic, auditable retrieval with zero LLM cost
   - Example queries:
     - "show shipments with >2 ETA changes in the last 14 days"
     - "list suppliers with lead-time increase >20% month-over-month"
     - "find records where carrier looks duplicated by spelling variation"

11. **Query with AI (Surreal + AI)**
   - Surreal retrieves evidence, AI synthesizes and explains patterns
   - Example (CO2/agriculture):
     - "There is a lot of CO2 and agriculture data here. Is there anything that could improve predictability accuracy for market participants doing speculation?"
   - Example (different domain: healthcare operations):
     - "Across these hospital staffing, admissions, and supply logs, which combined signals might improve short-horizon demand forecasting risk?"

12. **Review downloadable outputs and what they are for**
   - **Index manifest** (`/api/index-manifest/:cacheId`)
     - Snapshot of index run metadata/config and reproducibility context
   - **Indexed data export** (`/api/index-data-export/:cacheId`)
     - Extracted structured tables for external analysis/audit pipelines
   - **OpenClaw skill/config export** (`/api/openclaw-skill/:cacheId`)
     - Operator-ready instructions/context to automate or continue analysis in agent workflows

This flow is assisted end-to-end by AI + heuristics: planning, extraction strategy, retrieval mode selection, query conversion, and synthesis are all guided while still preserving auditable Surreal evidence.

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
- `GET /api/index-progress/:cacheId`
- `GET /api/index-manifest/:cacheId`
- `GET /api/index-data-export/:cacheId`
- `POST /api/index-diagnose/:cacheId`
- `GET /api/schema/:cacheId`
- `POST /api/convert-surrealql/:cacheId`
- `GET /api/openclaw-skill/:cacheId`
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

- Recipe-specific relationship builders by dataset class (narrative/report/structured/geo/communications)
- Strong extraction-quality gates before "ready for questions"
- Read-only execution mode for generated SurrealQL
- Query timeline visualization and relationship map
- Additional provider adapters (OpenAI/Anthropic/Together/local)
