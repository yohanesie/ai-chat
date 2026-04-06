/**
 * semantic-search.mjs — Hybrid Semantic Search + Synonym + LLM Reranker
 */

import { readFile }   from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname    = dirname(fileURLToPath(import.meta.url));
const OLLAMA_URL   = process.env.OLLAMA_URL   || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen-analyst";
const EMBED_MODEL  = process.env.EMBED_MODEL  || "nomic-embed-text";
const INDEX_FILE   = join(__dirname, "vector-index", "products-index.json");

// ── CACHE ─────────────────────────────────────────────
let productIndex = null;
let indexLoading = null;

// ── SYNONYMS ENGINE ───────────────────────────────────
const SYNONYMS = {
  mie: ["mi"],
  kopi: ["coffee"],
  susu: ["milk"],
  minuman: ["drink", "beverage"],
  air: ["water"],
  snack: ["camilan", "biskuit"],
  sepatu: ["shoes", "sneakers"],
  baju: ["kaos", "shirt"],
  celana: ["pants"],
  olahraga: ["sport", "fitness"],
  vitamin: ["supplement"],
  teh: ["tea"]
};

function expandQuery(query) {
  const tokens = query.toLowerCase().split(/\s+/);
  let expanded = new Set(tokens);

  tokens.forEach(t => {
    if (SYNONYMS[t]) {
      SYNONYMS[t].forEach(s => expanded.add(s));
    }
    for (const key in SYNONYMS) {
      if (SYNONYMS[key].includes(t)) {
        expanded.add(key);
      }
    }
  });

  return Array.from(expanded);
}

// ── UTILS ─────────────────────────────────────────────
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const normalize = (s) =>
  s.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9]/g, "");

// ── LOAD INDEX ────────────────────────────────────────
async function loadIndex() {
  if (productIndex) return productIndex;

  if (!indexLoading) {
    indexLoading = (async () => {
      if (!existsSync(INDEX_FILE)) {
        throw new Error("Index belum ada. Jalankan: node build-index.mjs");
      }
      const raw = await readFile(INDEX_FILE, "utf8");
      productIndex = JSON.parse(raw);
      console.error(`[SEMANTIC] ${productIndex.length} produk loaded`);
    })().finally(() => (indexLoading = null));
  }

  await indexLoading;
  return productIndex;
}

export function invalidateProductIndex() {
  productIndex = null;
  indexLoading = null;
}

// ── EMBEDDING ─────────────────────────────────────────
async function embedQuery(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EMBED_MODEL,
      prompt: text
    })
  });

  if (!res.ok) throw new Error("Embed error");
  const data = await res.json();
  return data.embedding;
}

// ── LLM RERANKER ──────────────────────────────────────
async function rerankWithLLM(query, items) {
  if (!items.length) return items;

  const prompt = `
Urutkan produk berdasarkan relevansi terhadap query.
Output HARUS JSON array index saja.

Query:
"${query}"

Produk:
${items.map((p, i) => `
[${i}] ${p.name}
Kategori: ${p.category}
Brand: ${p.brand}
Deskripsi: ${p.description}
`).join("\n")}
`;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        options: { temperature: 0 }
      })
    });

    const data = await res.json();
    const text = data.message?.content || "";

    const match = text.match(/\[.*\]/s);
    if (!match) return items;

    const order = JSON.parse(match[0]);
    const result = order.map(i => items[i]).filter(Boolean);

    return result.length ? result : items;

  } catch (err) {
    console.error("[RERANK ERROR]", err.message);
    return items;
  }
}

// ── MAIN SEARCH ───────────────────────────────────────
export async function searchProducts(query, {
  topK      = 10,
  threshold = 0.5,
  category  = null,
} = {}) {
  const index    = await loadIndex();
  const queryVec = await embedQuery(query);

  const originalTokens = query.toLowerCase().split(/\s+/);
  const tokens         = expandQuery(query);
  const qNorm          = normalize(query);

  // 1. BASE SCORE
  let results = index.map(p => ({
    id:          p.id,
    name:        p.name,
    category:    p.category,
    brand:       p.brand,
    description: p.description,
    baseScore:   cosineSimilarity(queryVec, p.embedding),
  }));

  // 2. HYBRID + SYNONYM + FUZZY
  results = results.map(r => {
    let boost = 0;
    let penalty = 0;

    const nameNorm = normalize(r.name);

    tokens.forEach(t => {
      const isOriginal = originalTokens.includes(t);
      const weight = isOriginal ? 0.4 : 0.2;

      if (r.name.toLowerCase().includes(t))        boost += weight;
      if (r.category.toLowerCase().includes(t))    boost += weight * 0.8;
      if (r.description.toLowerCase().includes(t)) boost += weight * 0.3;
      if (r.brand.toLowerCase().includes(t))       boost += weight;
    });

    // typo tolerance
    if (nameNorm.includes(qNorm)) boost += 1.0;

    // penalti kalau gak match sama sekali
    const hasMatch = tokens.some(t =>
      r.name.toLowerCase().includes(t) ||
      r.category.toLowerCase().includes(t) ||
      r.description.toLowerCase().includes(t)
    );

    if (!hasMatch) penalty += 0.2;

    return {
      ...r,
      score: r.baseScore + boost - penalty
    };
  });

  // 3. CATEGORY FILTER
  if (category) {
    const cat = category.toLowerCase();
    results = results.filter(r =>
      r.category.toLowerCase().includes(cat)
    );
  }

  // 4. SORT
  results.sort((a, b) => b.score - a.score);

  // 5. DYNAMIC THRESHOLD
  const best = results[0]?.score || 0;
  results = results.filter(r => r.score >= best * 0.6);

  if (!results.length) return [];

  // 6. CLAMP
  results = results.map(r => ({
    ...r,
    score: Math.min(r.score, 1)
  }));

  // 7. TOP RESULTS
  const topResults = results.slice(0, Math.min(topK, 8));

  // 8. CONDITIONAL RERANK
  let finalResults = topResults;

  if (topResults.length >= 3 && topResults[0].score < 0.9) {
    finalResults = await rerankWithLLM(query, topResults);
  }

  // 9. OUTPUT
  return finalResults.slice(0, topK).map(r => ({
    ...r,
    score: Math.round(r.score * 100) / 100,
  }));
}

// ── INFO ──────────────────────────────────────────────
export async function getIndexInfo() {
  if (!existsSync(INDEX_FILE)) {
    return { ready: false, message: "Index belum dibuat" };
  }

  const index = await loadIndex();
  const categories = [...new Set(index.map(p => p.category))];

  return {
    ready: true,
    total: index.length,
    categories
  };
}

export async function warmProductIndex() {
  try {
    const index = await loadIndex();
    return index.length;
  } catch {
    return 0;
  }
}