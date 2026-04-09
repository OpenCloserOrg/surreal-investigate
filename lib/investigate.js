export function tokenize(text = '') {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9@.$€£-]+/)
    .filter((t) => t && t.length >= 3);
}

export function analyzeChunk(text = '') {
  const value = String(text || '');
  const entities = [];
  const events = [];
  const anomalies = [];

  const emailRe = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
  const orgRe = /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3}\s(?:BV|B\.V\.|LLC|Ltd|Limited|Inc|Corp|Corporation|Holdings|Group|Partners))\b/g;
  const personRe = /\b([A-Z][a-z]+\s+[A-Z][a-z]+)\b/g;
  const moneyRe = /\b(?:USD|EUR|GBP|\$|€|£)?\s?\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})?\b/g;
  const dateRe = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Z][a-z]{2,8}\s+\d{4}|[A-Z][a-z]{2,8}\s+\d{1,2},\s*\d{4})\b/g;

  for (const m of value.matchAll(emailRe)) {
    entities.push({ type: 'email', value: m[0], normalized: m[0].toLowerCase(), confidence: 0.95 });
  }
  for (const m of value.matchAll(orgRe)) {
    entities.push({ type: 'organization', value: m[1], normalized: m[1].toLowerCase(), confidence: 0.8 });
  }
  for (const m of value.matchAll(personRe)) {
    entities.push({ type: 'person', value: m[1], normalized: m[1].toLowerCase(), confidence: 0.55 });
  }

  const dates = [...value.matchAll(dateRe)].map((m) => m[0]);
  for (const m of value.matchAll(moneyRe)) {
    const raw = m[0].trim();
    if (!/\d/.test(raw)) continue;
    const number = Number(raw.replace(/[^\d.]/g, ''));
    const currency = /€|EUR/i.test(raw) ? 'EUR' : (/£|GBP/i.test(raw) ? 'GBP' : (/\$|USD/i.test(raw) ? 'USD' : 'UNKNOWN'));
    events.push({ type: 'money', amount: Number.isFinite(number) ? number : null, currency, rawAmount: raw, dates, confidence: 0.7 });
  }

  const lower = value.toLowerCase();
  if (/under\s+.*threshold|split\s+payment|installments|fragmented\s+payments/.test(lower)) {
    anomalies.push({ type: 'threshold_splitting', severity: 'high', rationale: 'Possible structuring / threshold splitting language detected.' });
  }
  if (/delete\s+after\s+review|offshore|shell\s+entities?|nominee|zurich\s+channel|unlisted\s+number/.test(lower)) {
    anomalies.push({ type: 'concealment_signal', severity: 'medium', rationale: 'Potential concealment indicators detected.' });
  }
  if (/does not match|inconsisten|duplicate signature|abroad at the claimed signing/.test(lower)) {
    anomalies.push({ type: 'integrity_mismatch', severity: 'high', rationale: 'Inconsistency or integrity mismatch signal detected.' });
  }

  return {
    entities: dedupeBy(entities, (e) => `${e.type}:${e.normalized}`),
    events,
    anomalies
  };
}

export function buildCooccurrenceRelations(entities = []) {
  const out = [];
  const limited = entities.slice(0, 10);
  for (let i = 0; i < limited.length; i += 1) {
    for (let j = i + 1; j < limited.length; j += 1) {
      out.push({
        type: 'co_occurs_in_chunk',
        sourceType: limited[i].type,
        sourceValue: limited[i].value,
        targetType: limited[j].type,
        targetValue: limited[j].value,
        confidence: Math.min(limited[i].confidence || 0.5, limited[j].confidence || 0.5)
      });
    }
  }
  return out;
}

function dedupeBy(arr = [], keyFn = (v) => v) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
