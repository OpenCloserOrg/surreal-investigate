import { Surreal } from 'surrealdb';

const SURREAL_URL = process.env.SURREAL_URL || 'ws://127.0.0.1:8000/rpc';
const SURREAL_NS = process.env.SURREAL_NS || 'surreal_investigate';
const SURREAL_DB = process.env.SURREAL_DB || 'main';
const SURREAL_USER = process.env.SURREAL_USER || 'root';
const SURREAL_PASS = process.env.SURREAL_PASS || 'root';

export async function withSurreal(fn) {
  const db = new Surreal();
  try {
    await db.connect(SURREAL_URL);
    await db.signin({ username: SURREAL_USER, password: SURREAL_PASS });
    await db.use({ namespace: SURREAL_NS, database: SURREAL_DB });
    return await fn(db);
  } finally {
    try { await db.close(); } catch {}
  }
}

export async function ensureSchema(db) {
  await db.query(`
    DEFINE TABLE IF NOT EXISTS cache SCHEMALESS;
    DEFINE TABLE IF NOT EXISTS document SCHEMALESS;
    DEFINE TABLE IF NOT EXISTS chunk SCHEMALESS;
    DEFINE TABLE IF NOT EXISTS entity SCHEMALESS;
    DEFINE TABLE IF NOT EXISTS event SCHEMALESS;
    DEFINE TABLE IF NOT EXISTS relation SCHEMALESS;
    DEFINE TABLE IF NOT EXISTS anomaly SCHEMALESS;

    DEFINE INDEX IF NOT EXISTS chunk_cache_idx ON TABLE chunk COLUMNS cacheId;
    DEFINE INDEX IF NOT EXISTS doc_cache_idx ON TABLE document COLUMNS cacheId;
    DEFINE INDEX IF NOT EXISTS entity_cache_idx ON TABLE entity COLUMNS cacheId;
    DEFINE INDEX IF NOT EXISTS event_cache_idx ON TABLE event COLUMNS cacheId;
    DEFINE INDEX IF NOT EXISTS relation_cache_idx ON TABLE relation COLUMNS cacheId;
    DEFINE INDEX IF NOT EXISTS anomaly_cache_idx ON TABLE anomaly COLUMNS cacheId;
  `);
}

export const surrealConfig = { SURREAL_URL, SURREAL_NS, SURREAL_DB };
