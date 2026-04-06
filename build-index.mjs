/**
 * build-index.mjs — Build semantic search index untuk produk
 *
 * Cara pakai:
 *   node build-index.mjs                    ← pakai dummy-products.json
 *   node build-index.mjs ./products.json    ← pakai file produk custom
 *
 * Output: vector-index/products-index.json
 *
 * Fitur:
 * - Auto-resume: skip produk yang sudah ter-index
 * - Batch processing: embed N produk paralel
 * - Auto-test search setelah selesai
 * - Generate deskripsi otomatis via Qwen jika kosong
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync }                 from "fs";
import { join, dirname }              from "path";
import { fileURLToPath }              from "url";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const OLLAMA_URL  = process.env.OLLAMA_URL  || "http://127.0.0.1:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";
const LLM_MODEL   = process.env.OLLAMA_MODEL || "qwen-analyst";
const INPUT_FILE  = process.argv[2] || join(__dirname, "dummy-products.json");
const OUTPUT_DIR  = join(__dirname, "vector-index");
const OUTPUT_FILE = join(OUTPUT_DIR, "products-index.json");
const BATCH_SIZE  = 5;

// ── Cosine similarity ─────────────────────────────────────────
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Embed teks via nomic-embed-text ───────────────────────────
async function embedText(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Embed error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.embedding;
}

// ── Generate deskripsi via Qwen (untuk produk tanpa deskripsi) ─
async function generateDesc(product) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{
        role: "user",
        content: `Buatkan deskripsi produk singkat (1-2 kalimat) dalam Bahasa Indonesia untuk:
Nama: ${product.name}
Kategori: ${product.category || "-"}
Brand: ${product.brand || "-"}

Tulis HANYA deskripsi saja, tanpa label atau penjelasan tambahan.`,
      }],
      stream: false,
      options: { temperature: 0.3, num_predict: 100 },
    }),
  });
  if (!res.ok) return "";
  const data = await res.json();
  return data.message?.content?.trim() || "";
}

// ── Format teks produk untuk embedding ───────────────────────
function productToText(product) {
  return [
    product.name,
    product.name,       // bobot 2x untuk nama
    product.category || "",
    product.brand    || "",
    product.description || "",
  ].filter(Boolean).join(". ");
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 Build Semantic Search Index`);
  console.log(`   Input : ${INPUT_FILE}`);
  console.log(`   Output: ${OUTPUT_FILE}`);
  console.log(`   Embed : ${EMBED_MODEL}`);
  console.log(`   LLM   : ${LLM_MODEL}\n`);

  // 1. Load produk
  let products;
  try {
    products = JSON.parse(await readFile(INPUT_FILE, "utf8"));
    console.log(`✅ ${products.length} produk dimuat`);
  } catch (err) {
    console.error(`❌ Gagal baca input: ${err.message}`);
    process.exit(1);
  }

  // 2. Cek Ollama + model
  try {
    const res  = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await res.json();
    const hasEmbed = data.models?.some(m => m.name.includes(EMBED_MODEL.split(":")[0]));
    if (!hasEmbed) {
      console.error(`❌ Model '${EMBED_MODEL}' tidak ada. Jalankan: ollama pull ${EMBED_MODEL}`);
      process.exit(1);
    }
    console.log(`✅ Ollama online, model ${EMBED_MODEL} tersedia`);
  } catch {
    console.error(`❌ Ollama tidak bisa diakses di ${OLLAMA_URL}`);
    process.exit(1);
  }

  // 3. Buat output dir
  if (!existsSync(OUTPUT_DIR)) await mkdir(OUTPUT_DIR, { recursive: true });

  // 4. Load index existing (untuk resume)
  let existingIndex = [];
  if (existsSync(OUTPUT_FILE)) {
    try {
      existingIndex = JSON.parse(await readFile(OUTPUT_FILE, "utf8"));
      console.log(`📂 Index existing: ${existingIndex.length} produk`);
    } catch { existingIndex = []; }
  }

  const existingIds = new Set(existingIndex.map(p => p.id));
  const toEmbed     = products.filter(p => !existingIds.has(p.id));
  const skipped     = products.length - toEmbed.length;

  if (skipped > 0)         console.log(`⏭️  Skip ${skipped} produk (sudah ter-index)`);
  if (toEmbed.length === 0) {
    console.log(`\n✅ Semua produk sudah ter-index!`);
    await runTestSearch(existingIndex);
    return;
  }

  console.log(`\n⚡ Embed ${toEmbed.length} produk baru...\n`);

  // 5. Generate deskripsi untuk produk yang kosong
  const noDesc = toEmbed.filter(p => !p.description?.trim());
  if (noDesc.length > 0) {
    console.log(`📝 Generate deskripsi untuk ${noDesc.length} produk tanpa deskripsi...`);
    for (const p of noDesc) {
      try {
        p.description = await generateDesc(p);
        process.stdout.write(`   ✏️  ${p.name.slice(0, 40)}\n`);
      } catch {
        p.description = `${p.name} - produk ${p.category || ""} ${p.brand || ""}`.trim();
      }
    }
  }

  // 6. Embed dalam batch
  const newIndexed = [...existingIndex];
  let success = 0, failed = 0;

  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (product) => {
      try {
        const text      = productToText(product);
        const embedding = await embedText(text);
        newIndexed.push({
          id:          product.id,
          name:        product.name,
          category:    product.category  || "",
          brand:       product.brand     || "",
          description: product.description || "",
          embedding,
        });
        success++;
      } catch (err) {
        failed++;
        console.error(`\n   ❌ Gagal: ${product.name} — ${err.message}`);
      }
      process.stdout.write(`\r   Progress: ${success + failed}/${toEmbed.length} (✅ ${success} ❌ ${failed})`);
    }));

    // Auto-save setiap batch
    await writeFile(OUTPUT_FILE, JSON.stringify(newIndexed, null, 2), "utf8");
  }

  console.log(`\n\n📊 Selesai:`);
  console.log(`   ✅ Berhasil : ${success}`);
  if (failed > 0) console.log(`   ❌ Gagal   : ${failed}`);
  console.log(`   📦 Total   : ${newIndexed.length} produk di index`);
  console.log(`   💾 Disimpan: ${OUTPUT_FILE}\n`);

  await runTestSearch(newIndexed);
}

async function runTestSearch(index) {
  const queries = ["baju olahraga", "minuman segar", "bumbu masakan"];
  console.log(`\n🧪 Test search:`);
  for (const q of queries) {
    try {
      const qVec    = await embedText(q);
      const results = index
        .map(p => ({ name: p.name, category: p.category, score: cosineSimilarity(qVec, p.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      console.log(`\n   Query: "${q}"`);
      results.forEach((r, i) =>
        console.log(`   ${i + 1}. [${(r.score * 100).toFixed(0)}%] ${r.name}`)
      );
    } catch (err) {
      console.error(`   ❌ Test gagal: ${err.message}`);
    }
  }
  console.log(`\n✅ Index siap dipakai!\n`);
}

main().catch(err => {
  console.error(`\n❌ Fatal: ${err.message}`);
  process.exit(1);
});
