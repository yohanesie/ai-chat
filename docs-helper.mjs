/**
 * docs-helper.mjs — Helper untuk baca file .md dari folder docs/
 * Di-import oleh index.mjs
 */

import { readFile, readdir } from "fs/promises";
import { join, dirname }     from "path";
import { fileURLToPath }     from "url";

const __dirname  = dirname(fileURLToPath(import.meta.url));
export const DOCS_DIR = join(__dirname, "docs");

/** Rekursif scan semua file .md */
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

/** Cari keyword di semua file .md */
export async function searchDocs(keyword) {
  const files   = await scanMarkdownFiles(DOCS_DIR);
  const results = [];
  const kw      = keyword.toLowerCase();

  for (const filePath of files) {
    const content      = await readFile(filePath, "utf8");
    const relativePath = filePath
      .replace(DOCS_DIR, "")
      .replace(/\\/g, "/")
      .replace(/^\//, "");

    if (!content.toLowerCase().includes(kw)) continue;

    const lines   = content.split("\n");
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(kw)) continue;
      const start   = Math.max(0, i - 2);
      const end     = Math.min(lines.length - 1, i + 2);
      const snippet = lines.slice(start, end + 1).join("\n");
      if (!matches.includes(snippet)) matches.push(snippet);
    }
    if (matches.length > 0) results.push({ file: relativePath, matches });
  }
  return results;
}

/** Baca satu file .md */
export async function readDocFile(relPath) {
  const fullPath = join(DOCS_DIR, relPath);
  // Guard path traversal
  if (!fullPath.startsWith(DOCS_DIR)) throw new Error("Path tidak valid");
  if (!fullPath.endsWith(".md"))       throw new Error("Hanya file .md");
  return readFile(fullPath, "utf8");
}
