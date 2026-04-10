---
name: surreal-investigate-operator
description: Operate Surreal Investigate end-to-end from OpenClaw: create caches, upload files, generate data-model plus indexing strategy plans, index, diagnose extraction quality, convert natural language to SurrealQL, run query workflows, and export manifests/table data. Use when users want non-obvious pattern investigation with durable SurrealDB-backed memory.
---

# Surreal Investigate Operator Skill

## API-first workflow

1. Create cache via `POST /api/caches`.
2. Upload files via `POST /api/upload`.
3. Generate/refresh summary via `POST /api/cache-quick-summary/:cacheId`.
4. Generate model+strategy plans via `POST /api/index/feature-plans/:cacheId`.
5. Index via `POST /api/index/:cacheId`.
6. Check progress via `GET /api/index-progress/:cacheId`.
7. Query via `POST /api/query/:cacheId` in `surreal` or `ai` mode.

## Surreal-aware behavior

- Use Surreal-only mode for deterministic table/chunk retrieval checks.
- Use AI mode for synthesis, but ground answers in Surreal evidence.
- If extraction counts are near-zero, run `POST /api/index-diagnose/:cacheId` and propose re-index settings.

## Runtime assumptions

- Surreal Investigate UI/backend reachable (default `http://localhost:3000`).
- SurrealDB reachable per app env config.

## Read next

- `references/api-cookbook.md`
- `references/surrealql-examples.md`
- `references/troubleshooting.md`
