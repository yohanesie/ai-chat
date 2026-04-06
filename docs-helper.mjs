/**
 * docs-helper.mjs — Helper untuk baca file .md dari folder docs/
 * Di-import oleh index.mjs
 *
 * Fitur:
 * - RAM cache: scan disk hanya sekali, selanjutnya dari memori
 * - Thread-safe: cegah double load saat concurrent request
 * - Path traversal protection: resolve + sep check
 * - invalidateDocsCache(): dipanggil dari tool refresh_cache
 */

import { readFile, readdir } from "fs/promises";
import { join, dirname, resolve, sep } from "path";
import { fileURLToPath } from "url";

const __dirname   = dirname(fileURLToPath(import.meta.url));
export const DOCS_DIR = resolve(__dirname, "docs");

// ============================================================
//  SCAN REKURSIF
// ============================================================
export async function scanMarkdownFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await scanMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

// ============================================================
//  RAM CACHE
// ============================================================
let docsCache        = null;
let docsCacheLoading = null;

async function initDocsCache() {
  const files = await scanMarkdownFiles(DOCS_DIR);
  docsCache = await Promise.all(
    files.map(async (f) => {
      const content = await readFile(f, "utf8");
      return {
        path:         f,
        relativePath: f.replace(DOCS_DIR, "").replace(/\\/g, "/").replace(/^\//, ""),
        content,
      };
    })
  );
  console.error(`[DOCS-CACHE] ${docsCache.length} file dimuat ke RAM`);
}

export function invalidateDocsCache() {
  docsCache        = null;
  docsCacheLoading = null;
  console.error("[DOCS-CACHE] Cache diinvalidasi");
}

async function ensureCache() {
  if (docsCache) return;
  if (!docsCacheLoading) {
    docsCacheLoading = initDocsCache().finally(() => {
      docsCacheLoading = null;
    });
  }
  await docsCacheLoading;
}

export async function warmDocsCache() {
  await ensureCache();
  return docsCache?.length ?? 0; // ← tambah return ini
}

// ============================================================
//  SEARCH — dari RAM, bukan disk
// ============================================================
export async function searchDocs(keyword) {
  await ensureCache();

  const results = [];
  const kw      = keyword.toLowerCase();

  for (const doc of docsCache) {
    if (!doc.content.toLowerCase().includes(kw)) continue;

    const lines   = doc.content.split("\n");
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(kw)) continue;
      const start   = Math.max(0, i - 2);
      const end     = Math.min(lines.length - 1, i + 2);
      const snippet = lines.slice(start, end + 1).join("\n");
      if (!matches.includes(snippet)) matches.push(snippet);
    }
    if (matches.length > 0) results.push({ file: doc.relativePath, matches });
  }
  return results;
}

// ============================================================
//  READ SINGLE FILE — dengan path traversal protection
// ============================================================
export async function readDocFile(relPath) {
  const safePath = resolve(DOCS_DIR, relPath);

  if (!safePath.startsWith(DOCS_DIR + sep) && safePath !== DOCS_DIR) {
    throw new Error("Akses ditolak: path di luar direktori dokumen.");
  }
  if (!safePath.endsWith(".md")) {
    throw new Error("Hanya file .md yang diizinkan.");
  }

  return readFile(safePath, "utf8");
}
