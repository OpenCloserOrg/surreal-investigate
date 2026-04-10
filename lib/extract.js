import fs from 'fs';
import path from 'path';
import mammoth from 'mammoth';
import XLSX from 'xlsx';
import * as pdfParseModule from 'pdf-parse';
import AdmZip from 'adm-zip';
import { execFileSync, spawnSync } from 'child_process';
import os from 'os';

const SUPPORTED = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'eml', 'sql', 'pdf', 'docx', 'xlsx', 'xls', 'doc', 'epub']);

export function extensionOf(name = '') {
  const p = String(name).split('.');
  return p.length > 1 ? p.pop().toLowerCase() : '';
}

export function isSupported(name = '') {
  return SUPPORTED.has(extensionOf(name));
}

export function chunkText(text = '', max = 1400) {
  const clean = String(text || '').replace(/\r/g, '');
  const out = [];
  for (let i = 0; i < clean.length; i += max) out.push(clean.slice(i, i + max));
  return out.filter(Boolean);
}

function sanitizeRawText(input = '') {
  return String(input)
    .replace(/\u0000/g, ' ')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractRawFallback(buffer) {
  const utf8 = buffer.toString('utf8');
  const latin1 = buffer.toString('latin1');
  const pick = utf8.replace(/\uFFFD/g, '').length >= latin1.length * 0.7 ? utf8 : latin1;
  return sanitizeRawText(pick);
}

function extractEpubText(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const texts = [];
  for (const e of entries) {
    const n = String(e.entryName || '').toLowerCase();
    if (!/\.(xhtml|html|xml|txt|opf|ncx)$/i.test(n)) continue;
    const content = e.getData().toString('utf8');
    const stripped = content
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
    if (stripped.trim()) texts.push(stripped.trim());
  }
  return sanitizeRawText(texts.join('\n\n'));
}

function extractSpreadsheetText(absPath) {
  const wb = XLSX.readFile(absPath, { cellDates: true, dense: true });
  const parts = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    parts.push(`## Sheet: ${name}\n${csv}`);
  }
  return sanitizeRawText(parts.join('\n\n'));
}

function extractPdfWithPdftotext(absPath) {
  try {
    const txt = execFileSync('pdftotext', ['-layout', '-q', absPath, '-'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    });
    return sanitizeRawText(txt || '');
  } catch {
    return '';
  }
}

function commandExists(bin) {
  const r = spawnSync('bash', ['-lc', `command -v ${bin}`], { stdio: 'ignore' });
  return r.status === 0;
}

function looksLikePdfObjectJunk(text = '') {
  const v = String(text || '').toLowerCase();
  if (!v) return false;
  const markers = ['%pdf-', 'endobj', 'obj', 'flatedecode', 'xref', 'endstream'];
  const hits = markers.reduce((n, m) => n + (v.includes(m) ? 1 : 0), 0);
  return hits >= 2;
}

function extractPdfWithOcr(absPath) {
  if (!commandExists('pdftoppm') || !commandExists('tesseract')) return '';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-ocr-'));
  try {
    const prefix = path.join(tmpDir, 'page');
    execFileSync('pdftoppm', ['-f', '1', '-l', '3', '-png', absPath, prefix], { stdio: 'ignore' });
    const imgs = fs.readdirSync(tmpDir).filter((n) => n.endsWith('.png')).sort();
    const parts = [];
    for (const img of imgs) {
      try {
        const out = execFileSync('tesseract', [path.join(tmpDir, img), 'stdout', '-l', 'eng'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
        if (out?.trim()) parts.push(out.trim());
      } catch {}
    }
    return sanitizeRawText(parts.join('\n\n'));
  } catch {
    return '';
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function extractPdfWithPython(absPath) {
  const code = `
import sys
p = sys.argv[1]
text = ''
for lib in ('pypdf','PyPDF2','pdfplumber','pdfminer.high_level'):
    try:
        if lib == 'pypdf':
            from pypdf import PdfReader
            r = PdfReader(p)
            text = '\n\n'.join([(pg.extract_text() or '') for pg in r.pages[:40]])
        elif lib == 'PyPDF2':
            from PyPDF2 import PdfReader
            r = PdfReader(p)
            text = '\n\n'.join([(pg.extract_text() or '') for pg in r.pages[:40]])
        elif lib == 'pdfplumber':
            import pdfplumber
            with pdfplumber.open(p) as pdf:
                text = '\n\n'.join([(pg.extract_text() or '') for pg in pdf.pages[:40]])
        else:
            from pdfminer.high_level import extract_text
            text = extract_text(p, maxpages=40)
        if text and text.strip():
            print(text)
            sys.exit(0)
    except Exception:
        pass
sys.exit(0)
`;
  try {
    const out = execFileSync('python3', ['-c', code, absPath], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    return sanitizeRawText(out || '');
  } catch {
    return '';
  }
}

function wordCount(text = '') {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

export async function extractTextFromFile(absPath, filename = '') {
  const ext = extensionOf(filename || path.basename(absPath));
  const buffer = fs.readFileSync(absPath);

  try {
    if (['txt', 'md', 'csv', 'tsv', 'eml', 'sql'].includes(ext)) {
      return { supported: true, text: sanitizeRawText(buffer.toString('utf8')), method: 'plain' };
    }

    if (ext === 'json') {
      // Large JSON can be expensive to parse+pretty-print; prefer raw for speed.
      if (buffer.length > 5 * 1024 * 1024) {
        return { supported: true, text: sanitizeRawText(buffer.toString('utf8')), method: 'json-raw-large' };
      }
      try {
        const pretty = JSON.stringify(JSON.parse(buffer.toString('utf8')), null, 2);
        return { supported: true, text: pretty, method: 'json' };
      } catch {
        return { supported: true, text: sanitizeRawText(buffer.toString('utf8')), method: 'json-raw' };
      }
    }

    if (ext === 'pdf') {
      const pdfParse = pdfParseModule.default || pdfParseModule.pdfParse || pdfParseModule;
      let parsedText = '';
      try {
        const parsed = await pdfParse(buffer);
        parsedText = sanitizeRawText(parsed?.text || '');
      } catch {}

      const pdftotextText = extractPdfWithPdftotext(absPath);
      const pythonText = extractPdfWithPython(absPath);
      const ocrText = extractPdfWithOcr(absPath);

      const candidates = [
        { text: parsedText, method: 'pdf-parse' },
        { text: pdftotextText, method: 'pdf-pdftotext' },
        { text: pythonText, method: 'pdf-python-extractor' },
        { text: ocrText, method: 'pdf-ocr-tesseract' }
      ].map((c) => ({ ...c, words: wordCount(c.text) }))
        .filter((c) => c.words > 0 && !looksLikePdfObjectJunk(c.text))
        .sort((a, b) => b.words - a.words);

      if (candidates.length) {
        return { supported: true, text: candidates[0].text, method: candidates[0].method };
      }

      return { supported: true, text: '', method: 'pdf-no-readable-text-layer' };
    }

    if (ext === 'docx') {
      const out = await mammoth.extractRawText({ buffer });
      const text = sanitizeRawText(out?.value || '');
      if (text) return { supported: true, text, method: 'mammoth' };
      return { supported: true, text: extractRawFallback(buffer), method: 'docx-fallback' };
    }

    if (ext === 'xlsx' || ext === 'xls') {
      const text = extractSpreadsheetText(absPath);
      return { supported: true, text, method: 'xlsx' };
    }

    if (ext === 'epub') {
      const text = extractEpubText(buffer);
      return { supported: true, text, method: 'epub-zip' };
    }

    if (ext === 'doc') {
      // Legacy .doc is binary; fallback extraction still yields useful plaintext fragments.
      const text = extractRawFallback(buffer);
      return { supported: true, text, method: 'doc-raw-fallback' };
    }

    // Unknown extension: attempt raw fallback extraction as requested.
    return { supported: true, text: extractRawFallback(buffer), method: 'unknown-raw-fallback' };
  } catch (error) {
    // Best-effort behavior: return raw extraction instead of hard failure.
    return { supported: true, text: extractRawFallback(buffer), method: `error-fallback:${error.message}` };
  }
}

export function summarizeText(text = '') {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  return { charCount: text.length, wordCount: words.length };
}
