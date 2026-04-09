import fs from 'fs';
import path from 'path';

const SUPPORTED = new Set(['txt','md','csv','json','eml']);

export function extensionOf(name='') {
  const p = String(name).split('.');
  return p.length > 1 ? p.pop().toLowerCase() : '';
}

export function isSupported(name='') {
  return SUPPORTED.has(extensionOf(name));
}

export function chunkText(text='', max=1400) {
  const clean = String(text || '').replace(/\r/g, '');
  const out = [];
  for (let i = 0; i < clean.length; i += max) out.push(clean.slice(i, i + max));
  return out.filter(Boolean);
}

export function extractTextFromFile(absPath, filename='') {
  const ext = extensionOf(filename || path.basename(absPath));
  if (!SUPPORTED.has(ext)) return { supported: false, text: '', reason: `Unsupported extension: ${ext || 'unknown'}` };
  const buf = fs.readFileSync(absPath);
  let text = '';
  if (ext === 'json') {
    try { text = JSON.stringify(JSON.parse(buf.toString('utf8')), null, 2); }
    catch { text = buf.toString('utf8'); }
  } else {
    text = buf.toString('utf8');
  }
  return { supported: true, text };
}

export function summarizeText(text='') {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  return { charCount: text.length, wordCount: words.length };
}
