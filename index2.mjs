/**
 * tuf-ai-analyst — MCP Server v5.3.0
 *
 * Perubahan dari v5.2:
 * - Single-step SQL generation (lebih cepat, 1 LLM call)
 * - Fallback ke schema detail jika SQL gagal di-generate
 * - invalidateDocsCache() dipanggil saat refresh_cache
 * - warmDocsCache() dipanggil saat startup
 * - Fix filter allowedDocs: support file langsung di root docs/
 */

import { Server }               from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pkg from "pg";
import { readFile, writeFile, access, constants } from "fs/promises";
import { existsSync, writeFileSync }               from "fs";
import { fileURLToPath }                           from "url";
import { dirname, join }                           from "path";
import {
  DOCS_DIR,
  scanMarkdownFiles,
  searchDocs,
  readDocFile,
  warmDocsCache,
  invalidateDocsCache,
} from "./docs-helper.mjs";
import {
  searchProducts,
  getIndexInfo,
  warmProductIndex,
  invalidateProductIndex,
} from "./semantic-search.mjs";

const { Pool } = pkg;

// ============================================================
//  UTILS
// ============================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

async function loadEnvFile() {
  const envPath = join(__dirname, ".env");
  try {
    await access(envPath, constants.R_OK);
    const lines = (await readFile(envPath, "utf8")).split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[k]) process.env[k] = v;
    }
    log("CONFIG", ".env berhasil dimuat");
  } catch {
    log("WARN", "File .env tidak ditemukan, menggunakan env system");
  }
}

function getEnv(key, fallback) {
  const val = process.env[key];
  if (!val && fallback === undefined) {
    console.error(`[ERROR] Environment variable '${key}' tidak ditemukan!`);
    process.exit(1);
  }
  return val ?? fallback;
}

function log(tag, msg) {
  console.error(`[${tag}] ${msg}`);
}

// ============================================================
//  INISIALISASI ENV
// ============================================================
await loadEnvFile();

const DB_CONFIG = {
  user:                    getEnv("DB_USER",     "postgres"),
  host:                    getEnv("DB_HOST",     "localhost"),
  database:                getEnv("DB_NAME",     "konstruksi_db"),
  password:                getEnv("DB_PASS",     "admin"),
  port:                    parseInt(getEnv("DB_PORT", "5432")),
  max:                     10,
  idleTimeoutMillis:       30_000,
  connectionTimeoutMillis: 5_000,
};

const OLLAMA_URL     = getEnv("OLLAMA_URL",     "http://127.0.0.1:11434");
const OLLAMA_MODEL   = getEnv("OLLAMA_MODEL",   "qwen-analyst");
const MAX_ROWS       = parseInt(getEnv("MAX_ROWS",       "50"));
const MAX_JSON_CHARS = parseInt(getEnv("MAX_JSON_CHARS", "4000"));

const pool = new Pool(DB_CONFIG);

// ============================================================
//  KOLOM SENSITIF
// ============================================================
const SENSITIVE_COLUMNS = new Set([
  "password", "remember_token", "secret", "token",
  "api_key", "access_token", "refresh_token",
  "email_verified_at", "last_active_project_id",
  "avatar", "phone",
]);

// ============================================================
//  ⚙️  MANUAL RELATIONS — edit sesuai skema DB kamu
// ============================================================
const MANUAL_RELATIONS = {
  user_has_store: [
    "user_has_store.user_id → users.id",
    "user_has_store.store_id → stores.id",
  ],
  store_has_regionals: [
    "store_has_regionals.initial_store → stores.initial_store",
  ],
  item_stocks: [
    "item_stocks.plu → item_stocks_gold.plu",
    "item_stocks.location_code → locations.id",
    "item_stocks.initial_store → stores.initial_store",
  ],
};

// ============================================================
//  KNOWLEDGE BASE
// ============================================================
const KNOWLEDGE_FILE     = join(__dirname, "knowledge.md");
const KNOWLEDGE_TEMPLATE = `# Knowledge Base - DB Analyst

## konvensi
- initial_store adalah kode toko (string seperti "GBB", "JKT01"), BUKAN ID angka
- plu = Product Lookup Unit, identifier produk utama

## relasi
- Untuk join ke stores, gunakan stores.initial_store bukan stores.id
- item_stocks.location_code → locations.id (bukan locations.location_code)

## query

## lainnya
`;

let knowledgeCache = "";

async function loadKnowledge() {
  try {
    if (!existsSync(KNOWLEDGE_FILE)) {
      writeFileSync(KNOWLEDGE_FILE, KNOWLEDGE_TEMPLATE, "utf8");
      log("KNOWLEDGE", "File baru dibuat: knowledge.md");
    }
    knowledgeCache = await readFile(KNOWLEDGE_FILE, "utf8");
    log("KNOWLEDGE", `Loaded ${knowledgeCache.length} chars`);
  } catch (err) {
    log("WARN", `Gagal load knowledge.md: ${err.message}`);
    knowledgeCache = "";
  }
}

let _writeLock    = false;
const _writeQueue = [];

async function acquireWriteLock() {
  if (!_writeLock) { _writeLock = true; return; }
  await new Promise((resolve) => _writeQueue.push(resolve));
}

function releaseWriteLock() {
  if (_writeQueue.length > 0) _writeQueue.shift()();
  else _writeLock = false;
}

async function safeWriteKnowledge(newContent) {
  await acquireWriteLock();
  try {
    await writeFile(KNOWLEDGE_FILE, newContent, "utf8");
    knowledgeCache = newContent;
  } finally {
    releaseWriteLock();
  }
}

// ============================================================
//  CACHE SCHEMA DATABASE
// ============================================================
let tableNamesCache  = null;
let fkRelationsCache = null;
const schemaPerTable = {};

async function getTableNames() {
  if (tableNamesCache) return tableNamesCache;
  const res = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  tableNamesCache = res.rows.map((r) => r.table_name);
  log("CACHE", `${tableNamesCache.length} tabel di-cache`);
  return tableNamesCache;
}

async function getFKRelations() {
  if (fkRelationsCache !== null) return fkRelationsCache;
  try {
    const res = await pool.query(`
      SELECT kcu.table_name, kcu.column_name,
             ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    `);
    fkRelationsCache = {};
    for (const row of res.rows) {
      const hint = `${row.table_name}.${row.column_name} → ${row.foreign_table}.${row.foreign_column}`;
      if (!fkRelationsCache[row.table_name]) fkRelationsCache[row.table_name] = [];
      fkRelationsCache[row.table_name].push(hint);
    }
    log("CACHE", `FK otomatis: ${Object.keys(fkRelationsCache).length} tabel`);
  } catch (err) {
    log("WARN", `Gagal load FK: ${err.message}`);
    fkRelationsCache = {};
  }
  return fkRelationsCache;
}

async function getSchemaForTables(tableList) {
  const toFetch = tableList.filter((t) => !schemaPerTable[t]);
  if (toFetch.length > 0) {
    const ph  = toFetch.map((_, i) => `$${i + 1}`).join(",");
    const res = await pool.query(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN (${ph})
       ORDER BY table_name, ordinal_position`,
      toFetch
    );
    for (const row of res.rows) {
      if (!schemaPerTable[row.table_name]) schemaPerTable[row.table_name] = [];
      schemaPerTable[row.table_name].push(`${row.column_name}(${row.data_type})`);
    }
  }
  const result = {};
  for (const t of tableList) {
    result[t] = schemaPerTable[t]?.join(", ") || "kolom tidak ditemukan";
  }
  return result;
}

async function getRelationHints(tableList) {
  const fkAuto = await getFKRelations();
  const hints  = new Set();
  for (const t of tableList) {
    fkAuto[t]?.forEach((h) => hints.add(h));
    MANUAL_RELATIONS[t]?.forEach((h) => hints.add(h));
  }
  return [...hints];
}

function invalidateAllCaches() {
  tableNamesCache  = null;
  fkRelationsCache = null;
  Object.keys(schemaPerTable).forEach((k) => delete schemaPerTable[k]);
  log("CACHE", "Semua cache schema diinvalidasi");
}

function sanitizeRows(rows) {
  return rows.map((row) => {
    const clean = { ...row };
    for (const col of SENSITIVE_COLUMNS) delete clean[col];
    return clean;
  });
}

// ============================================================
//  VALIDASI SQL
// ============================================================
function extractSQL(rawSql) {
  const cb = rawSql.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (cb) return cb[1].trim();
  const lines = rawSql.split("\n");
  const idx   = lines.findIndex((l) => /^\s*(SELECT|WITH)\b/i.test(l));
  if (idx !== -1) return lines.slice(idx).join(" ").trim();
  return rawSql.trim();
}

function validateAndCleanSQL(rawSql) {
  let sql = extractSQL(rawSql);
  sql = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join(" ").replace(/\s+/g, " ").trim();

  const upper = sql.toUpperCase().trimStart();
  if (!upper.startsWith("SELECT") && !upper.startsWith("WITH")) {
    throw new Error(`SQL tidak valid — harus diawali SELECT atau WITH.\nRaw: ${rawSql.slice(0, 200)}`);
  }
  if ((sql.match(/;/g) || []).length > 1) throw new Error("Multi-statement SQL tidak diizinkan.");

  sql = sql.replace(/;\s*$/, "");

  const FORBIDDEN = /\b(DROP|DELETE|TRUNCATE|INSERT|UPDATE|ALTER|CREATE|GRANT|REVOKE|EXEC|EXECUTE|pg_sleep|pg_read_file)\b/i;
  if (FORBIDDEN.test(sql)) throw new Error("SQL mengandung keyword yang tidak diizinkan.");
  if (!/\bLIMIT\b/i.test(sql)) sql += ` LIMIT ${MAX_ROWS}`;

  return sql;
}

// ============================================================
//  OLLAMA LLM
// ============================================================
async function askLLM(systemPrompt, userPrompt) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      signal:  controller.signal,
      body: JSON.stringify({
        model:    OLLAMA_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
        stream: false,
        options: { temperature: 0, top_p: 0.9, repeat_penalty: 1.1, num_predict: 1024, num_ctx: 4096 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.message?.content?.trim() ?? "";
  } catch (err) {
    if (err.name === "AbortError") throw new Error("LLM timeout (>30 detik), coba ulangi.");
    if (err.code === "ECONNREFUSED") throw new Error(`Ollama tidak berjalan di ${OLLAMA_URL}.`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
//  GUARDS
// ============================================================
const DB_RELEVANT_KEYWORDS = [
  "tabel", "table", "kolom", "column", "field", "relasi", "join",
  "foreign key", "primary key", "query", "sql", "select", "schema",
  "=", "artinya", "berarti", "id", "kode", "status", "type",
  "projects", "users", "vendors", "locations", "items", "stores", "stocks",
  "transactions", "orders", "employees", "contracts", "budgets",
  "initial_store", "plu", "ext_code", "created_at", "updated_at",
  "konvensi", "relasi", "join ke", "foreign", "primary",
];
const ALLOWED_KATEGORI = new Set(["konvensi", "relasi", "query", "lainnya"]);

function isDbRelevantNote(catatan) {
  const lower = catatan.toLowerCase();
  return DB_RELEVANT_KEYWORDS.some((kw) => lower.includes(kw));
}

const CATATAN_KEYWORDS = [
  "catatan", "knowledge", "memory", "ingatan", "kamu ingat",
  "knowledge base", "baca catatan", "lihat catatan", "tampilkan catatan", "apa yang kamu",
];

function isCatatanIntent(text) {
  const lower = text.toLowerCase();
  return CATATAN_KEYWORDS.some((kw) => lower.includes(kw));
}

// ============================================================
//  FORMAT OUTPUT
// ============================================================
function formatQueryResult({ tables, relationHints, sql, rows, totalRows }) {
  const truncated = totalRows > MAX_ROWS;
  let   jsonStr   = JSON.stringify(rows, null, 2);
  let   jsonNote  = "";
  if (jsonStr.length > MAX_JSON_CHARS) {
    jsonStr  = jsonStr.slice(0, MAX_JSON_CHARS);
    jsonNote = `\n⚠️  Output dipotong. Gunakan filter lebih spesifik.`;
  }
  return [
    `📋 Tabel   : ${tables.join(", ")}`,
    relationHints.length ? `🔗 Relasi   : ${relationHints.join(" | ")}` : null,
    `🔍 SQL     : ${sql}`,
    ``,
    truncated ? `⚠️  Ditampilkan ${MAX_ROWS} dari ${totalRows} baris` : `✅ ${rows.length} baris ditemukan`,
    jsonStr + jsonNote,
  ].filter(Boolean).join("\n");
}

// ============================================================
//  HELPER: filter docs berdasarkan allowedFolders
//  Support file di root docs/ (glosarium.md) DAN subfolder (hr/cuti.md)
// ============================================================
function filterByAllowedFolders(files, allowedFolders, docsDir) {
  if (!allowedFolders || allowedFolders.length === 0) return files;
  return files.filter(f => {
    const rel = f.replace(docsDir, "").replace(/\\/g, "/").replace(/^\//, "");
    return allowedFolders.some(folder =>
      rel.startsWith(folder + "/") || // file di subfolder: "glosarium/glosarium.md"
      rel === folder + ".md"           // file langsung di root: "glosarium.md"
    );
  });
}

function filterResultsByAllowedFolders(results, allowedFolders) {
  if (!allowedFolders || allowedFolders.length === 0) return results;
  return results.filter(r =>
    allowedFolders.some(folder =>
      r.file.startsWith(folder + "/") ||
      r.file === folder + ".md"
    )
  );
}

// ============================================================
//  MCP SERVER
// ============================================================
const server = new Server(
  { name: "tuf-ai-analyst", version: "5.4.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "daftar_tabel",
      description: "Tampilkan semua nama tabel di database. Gunakan HANYA jika user eksplisit bertanya 'tabel apa saja yang ada'. JANGAN panggil sebelum tanya_database.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "lihat_struktur_tabel",
      description: "Tampilkan struktur kolom dari satu atau beberapa tabel. Contoh: 'lihat struktur tabel locations' atau 'lihat struktur tabel locations, stores'.",
      inputSchema: {
        type: "object",
        properties: {
          nama_tabel: { type: "string", description: "Satu atau beberapa nama tabel dipisah koma." },
        },
        required: ["nama_tabel"],
        additionalProperties: false,
      },
    },
    {
      name: "tanya_database",
      description: "Gunakan HANYA untuk query data tabel database seperti users, stores, transactions. JANGAN gunakan untuk pencarian produk atau katalog. JANGAN gunakan untuk membaca catatan — gunakan baca_catatan. Input berupa pertanyaan Bahasa Indonesia, BUKAN SQL mentah.",
      inputSchema: {
        type: "object",
        properties: {
          pertanyaan: { type: "string", description: "Pertanyaan natural language tentang data." },
        },
        required: ["pertanyaan"],
        additionalProperties: false,
      },
    },
    {
      name: "tulis_catatan",
      description: "Simpan catatan tentang database: konvensi kolom, relasi tabel, atau contoh query. HANYA gunakan jika user EKSPLISIT meminta menyimpan catatan. Wajib isi field user_confirmed=true.",
      inputSchema: {
        type: "object",
        properties: {
          catatan:        { type: "string",  description: "Catatan tentang database." },
          kategori:       { type: "string",  enum: ["konvensi", "relasi", "query", "lainnya"] },
          user_confirmed: { type: "boolean", description: "Set true jika user eksplisit minta simpan. WAJIB." },
        },
        required: ["catatan", "kategori", "user_confirmed"],
        additionalProperties: false,
      },
    },
    {
      name: "baca_catatan",
      description: "Baca semua catatan yang tersimpan di knowledge base. Trigger: 'tampilkan catatan', 'apa yang kamu ingat'. BUKAN untuk query data database.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "perbarui_catatan",
      description: "Perbaiki atau ganti teks spesifik di dalam catatan yang salah.",
      inputSchema: {
        type: "object",
        properties: {
          teks_lama: { type: "string", description: "Teks yang salah (case-sensitive)." },
          teks_baru: { type: "string", description: "Teks baru yang benar." },
        },
        required: ["teks_lama", "teks_baru"],
        additionalProperties: false,
      },
    },
    {
      name: "hapus_semua_catatan",
      description: "Reset seluruh knowledge base ke template awal.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "refresh_cache",
      description: "Invalidasi cache schema database dan docs, muat ulang dari sumber. Gunakan jika ada tabel baru atau file docs baru.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "list_dokumen",
      description: "Tampilkan semua file .md di folder docs. Gunakan jika user tanya 'dokumen apa saja yang ada'.",
      inputSchema: {
        type: "object",
        properties: {
          allowed_folders: { type: "array", items: { type: "string" }, description: "Folder yang boleh diakses. Kosong = semua." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "cari_dokumen",
      description: "Cari keyword di semua file .md (peraturan, SOP, kebijakan, glosarium). Trigger: 'apa itu X', 'peraturan X', 'prosedur X'. Return potongan teks relevan.",
      inputSchema: {
        type: "object",
        properties: {
          keyword:         { type: "string", description: "Kata kunci yang dicari." },
          allowed_folders: { type: "array", items: { type: "string" }, description: "Folder yang boleh diakses. Kosong = semua." },
        },
        required: ["keyword"],
        additionalProperties: false,
      },
    },
    {
      name: "baca_dokumen",
      description: "Baca isi lengkap satu file .md. Contoh path: 'glosarium/glosarium.md', 'hr/cuti.md'.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relatif dari folder docs." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "cari_produk",
      description: "Gunakan untuk mencari produk/barang berdasarkan kata kunci seperti 'makanan','minuman', 'sepatu', 'isotonic', dll.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Kata kunci pencarian produk"
          },
          kategori: {
            type: "string",
            description: "Filter kategori (optional)"
          },
          top_k: {
            type: "number",
            description: "Jumlah hasil (default 10, max 20)"
          }
        },
        required: ["query"],
        additionalProperties: false
      }
    },
    {
      name: "info_produk_index",
      description: "Menampilkan status index produk (jumlah, kategori, dll).",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    },
  ],
}));

// ============================================================
//  HANDLER UTAMA
// ============================================================
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args     = request.params.arguments || {};

  try {

    // ── daftar_tabel ─────────────────────────────────────────
    if (toolName === "daftar_tabel") {
      const tables = await getTableNames();
      return { content: [{ type: "text", text: `📦 ${tables.length} tabel:\n${tables.map(t => `  - ${t}`).join("\n")}` }] };
    }

    // ── lihat_struktur_tabel ──────────────────────────────────
    if (toolName === "lihat_struktur_tabel") {
      const allTables   = await getTableNames();
      const inputTables = (args.nama_tabel || "").split(",")
        .map(t => t.trim().toLowerCase())
        .filter(t => allTables.includes(t));

      if (inputTables.length === 0) {
        return { content: [{ type: "text", text: `❌ Tabel tidak ditemukan.\nTersedia: ${allTables.slice(0, 30).join(", ")}` }] };
      }

      const ph  = inputTables.map((_, i) => `$${i + 1}`).join(",");
      const res = await pool.query(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name IN (${ph})
         ORDER BY table_name, ordinal_position`,
        inputTables
      );

      const grouped = {};
      for (const row of res.rows) {
        if (!grouped[row.table_name]) grouped[row.table_name] = [];
        grouped[row.table_name].push(`${row.column_name} (${row.data_type})`);
      }

      const lines = Object.entries(grouped).map(
        ([t, cols]) => `📋 ${t}:\n${cols.map(c => `  - ${c}`).join("\n")}`
      );
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }

    // ── tulis_catatan ─────────────────────────────────────────
    if (toolName === "tulis_catatan") {
      const catatan       = (args.catatan  || "").trim();
      const kategori      = (args.kategori || "lainnya").toLowerCase();
      const userConfirmed = args.user_confirmed === true;

      if (!catatan)        return { content: [{ type: "text", text: "❌ Catatan tidak boleh kosong." }] };
      if (!userConfirmed)  return { content: [{ type: "text", text: "⛔ user_confirmed harus true." }] };
      if (!ALLOWED_KATEGORI.has(kategori)) {
        return { content: [{ type: "text", text: `❌ Kategori '${kategori}' tidak valid.` }] };
      }
      if (!isDbRelevantNote(catatan)) {
        return { content: [{ type: "text", text: "⛔ Catatan ditolak — tidak relevan dengan database." }] };
      }

      const timestamp     = new Date().toISOString().split("T")[0];
      const entry         = `\n- [${timestamp}] ${catatan}`;
      let   content       = await readFile(KNOWLEDGE_FILE, "utf8");
      const sectionHeader = `## ${kategori}`;
      if (!content.includes(sectionHeader)) content += `\n${sectionHeader}\n`;
      content = content.replace(sectionHeader, `${sectionHeader}${entry}`);

      await safeWriteKnowledge(content);
      log("KNOWLEDGE", `[${kategori}]: ${catatan}`);
      return { content: [{ type: "text", text: `✅ Catatan disimpan di kategori '${kategori}'.` }] };
    }

    // ── baca_catatan ──────────────────────────────────────────
    if (toolName === "baca_catatan") {
      if (!knowledgeCache || knowledgeCache.trim().length < 20) {
        return { content: [{ type: "text", text: "📭 Knowledge base masih kosong." }] };
      }
      const sections = knowledgeCache.split(/^## /m).filter(Boolean);
      const filled   = sections
        .map(s => s.trim())
        .filter(s => s.split("\n").slice(1).some(l => l.trim() !== ""))
        .map(s => `## ${s}`);
      if (filled.length === 0) return { content: [{ type: "text", text: "📭 Knowledge base kosong." }] };
      return { content: [{ type: "text", text: `📚 Catatan tersimpan:\n\n${filled.join("\n\n")}` }] };
    }

    // ── perbarui_catatan ──────────────────────────────────────
    if (toolName === "perbarui_catatan") {
      const teksLama = (args.teks_lama || "").trim();
      const teksBaru = (args.teks_baru || "").trim();
      if (!teksLama || !teksBaru) return { content: [{ type: "text", text: "❌ teks_lama dan teks_baru wajib diisi." }] };
      const content = await readFile(KNOWLEDGE_FILE, "utf8");
      if (!content.includes(teksLama)) return { content: [{ type: "text", text: "❌ Teks lama tidak ditemukan (case-sensitive)." }] };
      await safeWriteKnowledge(content.replace(teksLama, teksBaru));
      log("KNOWLEDGE", `Diperbarui: "${teksLama}" → "${teksBaru}"`);
      return { content: [{ type: "text", text: "✅ Catatan berhasil diperbarui." }] };
    }

    // ── hapus_semua_catatan ───────────────────────────────────
    if (toolName === "hapus_semua_catatan") {
      await safeWriteKnowledge(KNOWLEDGE_TEMPLATE);
      return { content: [{ type: "text", text: "🗑️ Knowledge base direset." }] };
    }

    // ── refresh_cache ─────────────────────────────────────────
    if (toolName === "refresh_cache") {
      invalidateAllCaches();
      invalidateDocsCache();
      const tables    = await getTableNames();
      await getFKRelations();
      const docsCount = await warmDocsCache();
      return {
        content: [{
          type: "text",
          text: `✅ Cache diperbarui:\n- ${tables.length} tabel schema\n- ${docsCount} file docs`,
        }],
      };
    }

    // ── tanya_database ────────────────────────────────────────
    if (toolName === "tanya_database") {
      let pertanyaan = (args.pertanyaan || "").trim();
      if (typeof pertanyaan === "object") pertanyaan = pertanyaan.value ?? JSON.stringify(pertanyaan);
      if (!pertanyaan) return { content: [{ type: "text", text: "❌ Pertanyaan tidak boleh kosong." }] };

      // Redirect jika intent tanya catatan
      if (isCatatanIntent(pertanyaan)) {
        if (!knowledgeCache || knowledgeCache.trim().length < 20) {
          return { content: [{ type: "text", text: "📭 Catatan kosong." }] };
        }
        const answer = await askLLM(
          "Jawab berdasarkan catatan database. Jika tidak ada, katakan tidak tahu.",
          `Catatan:\n${knowledgeCache}\n\nPertanyaan: "${pertanyaan}"`
        );
        return { content: [{ type: "text", text: answer }] };
      }

      const allTables    = await getTableNames();
      const knowledgeCtx = knowledgeCache.trim() ? `\nCatatan Penting:\n${knowledgeCache}\n` : "";

      // ── SINGLE STEP: Generate SQL ─────────────────────────
      log("SQL-GEN", `Single-step: ${pertanyaan}`);
      const sqlRaw = await askLLM(
        [
          "[DB: PostgreSQL]",
          `Tabel tersedia: ${allTables.join(", ")}`,
          knowledgeCtx,
          "Tugas: Hasilkan SQL SELECT valid. HANYA SQL murni dimulai SELECT atau WITH.",
          "DILARANG menulis penjelasan. Gunakan JOIN jika tabel berhubungan.",
        ].join("\n"),
        `Pertanyaan: "${pertanyaan}"\nSQL:`
      );

      let sql;
      try {
        sql = validateAndCleanSQL(sqlRaw);
      } catch (err) {
        // ── FALLBACK: retry dengan schema detail ──────────
        log("FALLBACK", `SQL gagal, retry dengan schema. Error: ${err.message}`);
        const mentionedTables = allTables
          .filter(t => pertanyaan.toLowerCase().includes(t))
          .slice(0, 4);

        if (mentionedTables.length > 0) {
          const schemas       = await getSchemaForTables(mentionedTables);
          const relationHints = await getRelationHints(mentionedTables);
          const schemaCtx     = mentionedTables.map(t => `${t}(${schemas[t]})`).join("\n");
          const relationCtx   = relationHints.length
            ? `\nRelasi:\n${relationHints.map(r => `  - ${r}`).join("\n")}`
            : "";

          const sqlRetry = await askLLM(
            [
              "[DB: PostgreSQL]", knowledgeCtx,
              "Skema (HANYA gunakan kolom ini):", schemaCtx + relationCtx,
              "Tugas: Hasilkan SQL SELECT valid. HANYA SQL, tanpa penjelasan.",
            ].join("\n"),
            `Pertanyaan: "${pertanyaan}"\nSQL:`
          );
          try {
            sql = validateAndCleanSQL(sqlRetry);
            log("FALLBACK", "SQL berhasil dengan schema detail");
          } catch (err2) {
            return { content: [{ type: "text", text: `❌ Gagal generate SQL: ${err2.message}` }] };
          }
        } else {
          return { content: [{ type: "text", text: `❌ Gagal generate SQL: ${err.message}\nCoba sebutkan nama tabel secara eksplisit.` }] };
        }
      }

      // ── Eksekusi ──────────────────────────────────────────
      log("EXEC", sql);
      let dbResult;
      try {
        dbResult = await pool.query(sql);
      } catch (dbErr) {
        return { content: [{ type: "text", text: `❌ DB error (${dbErr.code}): ${dbErr.message}\nSQL: ${sql}` }] };
      }

      const allRows       = sanitizeRows(dbResult.rows);
      const totalRows     = allRows.length;
      const rows          = allRows.slice(0, MAX_ROWS);
      const usedTables    = allTables.filter(t => sql.toLowerCase().includes(t));
      const relationHints = await getRelationHints(usedTables);

      return {
        content: [{
          type: "text",
          text: formatQueryResult({ tables: usedTables, relationHints, sql, rows, totalRows }),
        }],
      };
    }

    // ── list_dokumen ──────────────────────────────────────────
    if (toolName === "list_dokumen") {
      const allowedFolders = args.allowed_folders || [];
      const allFiles       = await scanMarkdownFiles(DOCS_DIR);
      const files          = filterByAllowedFolders(allFiles, allowedFolders, DOCS_DIR);

      if (files.length === 0) return { content: [{ type: "text", text: "📭 Belum ada dokumen yang bisa diakses." }] };

      const list = files.map(f => {
        const rel = f.replace(DOCS_DIR, "").replace(/\\/g, "/").replace(/^\//, "");
        return `  - ${rel}`;
      });
      return { content: [{ type: "text", text: `📁 ${files.length} dokumen:\n${list.join("\n")}` }] };
    }

    // ── cari_dokumen ──────────────────────────────────────────
    if (toolName === "cari_dokumen") {
      const keyword        = (args.keyword || "").trim();
      const allowedFolders = args.allowed_folders || [];

      if (!keyword) return { content: [{ type: "text", text: "❌ Keyword tidak boleh kosong." }] };

      let results = await searchDocs(keyword);
      results     = filterResultsByAllowedFolders(results, allowedFolders);

      if (results.length === 0) {
        return { content: [{ type: "text", text: `🔍 Tidak ditemukan keyword "${keyword}".` }] };
      }

      const output = results.map(({ file, matches }) =>
        `📄 ${file}:\n${matches.map(m => `  > ${m.replace(/\n/g, "\n    ")}`).join("\n")}`
      ).join("\n\n");

      log("DOCS", `cari_dokumen("${keyword}") → ${results.length} file`);
      return { content: [{ type: "text", text: `🔍 Hasil "${keyword}":\n\n${output}` }] };
    }

    // ── baca_dokumen ──────────────────────────────────────────
      if (toolName === "baca_dokumen") {
        const relPath = (args.path || "").trim().replace(/\\/g, "/");
        if (!relPath || relPath.includes("..") || relPath.startsWith("/")) {
          return { content: [{ type: "text", text: "❌ Path tidak valid." }] };
        }
        try {
          const content = await readDocFile(relPath);
          const limit   = 10_000;
          const isTrunc = content.length > limit;
          const final   = isTrunc ? content.slice(0, limit) + "\n\n... (dipotong)" : content;
          log("DOCS", `baca_dokumen("${relPath}") → ${final.length} chars`);
          return { content: [{ type: "text", text: `📄 ${relPath}:\n\n${final}` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `❌ ${e.message}` }] };
        }
      }

      // ── cari_produk ───────────────────────────────────────────
      if (toolName === "cari_produk") {
        const query    = (args.query || "").trim();
        const kategori = args.kategori || null;
        const topK     = Math.min(args.top_k || 10, 20);

        if (!query) return { content: [{ type: "text", text: "❌ Query tidak boleh kosong." }] };

        let results;
        try {
          results = await searchProducts(query, { topK, threshold: 0.25, category: kategori });
        } catch (err) {
          if (err.message.includes("Index belum ada")) {
            return { content: [{ type: "text", text: "❌ Index produk belum dibuat. Jalankan: node build-index.mjs" }] };
          }
          throw err;
        }

        if (results.length === 0) {
          return { content: [{ type: "text", text: `🔍 Tidak ada produk relevan untuk "${query}".` }] };
        }

        const lines = results.map((r, i) =>
          `${i + 1}. **${r.name}** (${r.category})
    Brand: ${r.brand} | Relevansi: ${Math.round(r.score * 100)}%
    ${r.description}`
        );

        log("SEMANTIC", `cari_produk("${query}") → ${results.length} hasil`);
        return {
          content: [{
            type: "text",
            text: `🛍️ Hasil pencarian "${query}" (${results.length} produk):

  ${lines.join("\n\n")}`,
          }],
        };
      }

    // ── info_produk_index ─────────────────────────────────────
    if (toolName === "info_produk_index") {
    const info = await getIndexInfo();
    if (!info.ready) {
      return { content: [{ type: "text", text: `❌ ${info.message}` }] };
    }
    return {
      content: [{
        type: "text",
        text: [
          `📦 Product Index Status:`,
          `   Total produk : ${info.total}`,
          `   Kategori     : ${info.categories.join(", ")}`,
          `   Status       : ✅ Siap digunakan`,
        ].join("\n"),
      }],
    };
  }

    // ── Fallback ──────────────────────────────────────────────
    return { content: [{ type: "text", text: `❌ Tool '${toolName}' tidak dikenal.` }] };

  } catch (err) {
    log("ERROR", `${toolName}: ${err.message}`);
    return { content: [{ type: "text", text: `❌ Internal error: ${err.message}` }] };
  }
});

// ============================================================
//  STARTUP
// ============================================================
await loadKnowledge();

try {
  await getTableNames();
  await getFKRelations();
  const docsCount    = await warmDocsCache();
  const productCount = await warmProductIndex();
  log("READY", "tuf-ai-analyst v5.4.0");
  log("READY", "Model    : " + OLLAMA_MODEL);
  log("READY", "DB       : " + DB_CONFIG.database + "@" + DB_CONFIG.host + ":" + DB_CONFIG.port);
  log("READY", "Docs     : " + docsCount + " file di-cache ke RAM");
  log("READY", "Products : " + (productCount > 0 ? productCount + " produk ter-index" : "index belum ada — jalankan: node build-index.mjs"));
} catch (err) {
  log("ERROR", "Gagal startup: " + err.message);
  process.exit(1);
}

const transport = new StdioServerTransport();
await server.connect(transport);
