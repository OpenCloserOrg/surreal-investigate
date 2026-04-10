# Troubleshooting

## No entities/events/activities after index
1. Check extracted chars in upload table.
2. Run `POST /api/index-diagnose/:cacheId`.
3. Re-index with detected recipe defaults + explicit main intent.
4. Verify OCR path for scanned PDFs.

## Surreal pre-check timeout
- Verify SurrealDB is reachable and app has correct URL/credentials.
- Retry from UI; if repeated, inspect server logs.

## Conversion to SurrealQL not useful
- Open schema view and verify expected fields exist.
- If `needsRemodel=true`, apply `remodelInstructions` into custom strategy notes, regenerate plans, re-index.

## Operational behavior for OpenClaw agents
- Ask user when runtime path/config is unknown.
- If git/permissions available, commit fixes and open PR for durable improvements.
