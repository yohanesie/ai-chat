/**
 * tuf-ai-analyst — MCP Server v5.1.0
 *
 * Perubahan dari v5.0:
 * - Guard hallucination di tulis_catatan:
 *     - Blok kategori di luar whitelist DB (konvensi/relasi/query/lainnya)
 *     - Deteksi isi catatan yang tidak relevan dengan database
 *     - Wajib konfirmasi eksplisit user via flag user_confirmed
 * - daftar_tabel TIDAK dipanggil otomatis sebelum tanya_database
 *     - Description diperketat agar model tidak redundant call
 * - System prompt rekomendasi untuk Chatbox disertakan di README
 * - Output tanya_database: tampilkan data RAW tanpa ringkasan
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
} from "./docs-helper.mjs";

const { Pool } = pkg;

// ============================================================
//  UTILS — .env loader (tanpa dotenv)
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
  user:                   getEnv("DB_USER",     "postgres"),
  host:                   getEnv("DB_HOST",     "localhost"),
  database:               getEnv("DB_NAME",     "konstruksi_db"),
  password:               getEnv("DB_PASS",     "admin"),
  port:                   parseInt(getEnv("DB_PORT", "5432")),
  max:                    10,
  idleTimeoutMillis:      30_000,
  connectionTimeoutMillis: 5_000,
};

const OLLAMA_URL   = getEnv("OLLAMA_URL",   "http://127.0.0.1:11434");
const OLLAMA_MODEL = getEnv("OLLAMA_MODEL", "llama3.1:8b");
const MAX_ROWS     = parseInt(getEnv("MAX_ROWS", "50"));

const pool = new Pool(DB_CONFIG);

// ============================================================
//  KONFIGURASI KOLOM SENSITIF
// ============================================================
const SENSITIVE_COLUMNS = new Set([
  "password", "remember_token", "secret", "token",
  "api_key", "access_token", "refresh_token",
  "email_verified_at", "last_active_project_id",
  "avatar", "phone",
]);

// ============================================================
//  MANUAL RELATIONS
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
const KNOWLEDGE_FILE = join(__dirname, "knowledge.md");
const KNOWLEDGE_TEMPLATE = `# Knowledge Base - DB Analyst

## konvensi

## relasi

## query

## lainnya
`;

// In-memory cache untuk knowledge
let knowledgeCache = "";

async function loadKnowledge() {
  try {
    const exists = existsSync(KNOWLEDGE_FILE);
    if (!exists) {
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

// ── Mutex untuk file write (cegah race condition) ────────────
let _writeLock = false;
const _writeQueue = [];

async function acquireWriteLock() {
  if (!_writeLock) {
    _writeLock = true;
    return;
  }
  await new Promise((resolve) => _writeQueue.push(resolve));
}

function releaseWriteLock() {
  if (_writeQueue.length > 0) {
    _writeQueue.shift()();
  } else {
    _writeLock = false;
  }
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
    SELECT table_name
    FROM information_schema.tables
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
      SELECT
        kcu.table_name,
        kcu.column_name,
        ccu.table_name  AS foreign_table,
        ccu.column_name AS foreign_column
      FROM information_schema.table_constraints      AS tc
      JOIN information_schema.key_column_usage       AS kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema    = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema    = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema    = 'public'
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
    const placeholders = toFetch.map((_, i) => `$${i + 1}`).join(",");
    const res = await pool.query(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN (${placeholders})
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

// ── Invalidate semua cache (untuk refresh_cache tool) ────────
function invalidateAllCaches() {
  tableNamesCache  = null;
  fkRelationsCache = null;
  Object.keys(schemaPerTable).forEach((k) => delete schemaPerTable[k]);
  log("CACHE", "Semua cache diinvalidasi");
}

function sanitizeRows(rows) {
  return rows.map((row) => {
    const clean = { ...row };
    for (const col of SENSITIVE_COLUMNS) delete clean[col];
    // Strip nilai yang terlihat seperti hash (bcrypt, sha, dll)
    for (const [key, val] of Object.entries(clean)) {
      if (typeof val === "string" && /^$2[aby]$d+$/.test(val)) {
        clean[key] = "[hash]";
      }
    }
    return clean;
  });
}

// ============================================================
//  VALIDASI SQL
// ============================================================
function extractSQL(rawSql) {
  // 1. Dari code block ```sql ... ```
  const codeBlock = rawSql.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (codeBlock) return codeBlock[1].trim();

  // 2. Cari baris yang diawali SELECT / WITH
  const lines    = rawSql.split("\n");
  const startIdx = lines.findIndex((l) => /^\s*(SELECT|WITH)\b/i.test(l));
  if (startIdx !== -1) return lines.slice(startIdx).join(" ").trim();

  return rawSql.trim();
}

function validateAndCleanSQL(rawSql) {
  let sql = extractSQL(rawSql);

  // Hapus komentar SQL inline
  sql = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const upper = sql.toUpperCase().trimStart();
  if (!upper.startsWith("SELECT") && !upper.startsWith("WITH")) {
    throw new Error(
      `SQL tidak valid — harus diawali SELECT atau WITH.\nRaw output: ${rawSql.slice(0, 300)}`
    );
  }

  // Cegah multi-statement
  const semicolonCount = (sql.match(/;/g) || []).length;
  if (semicolonCount > 1) {
    throw new Error("Multi-statement SQL tidak diizinkan.");
  }

  sql = sql.replace(/;\s*$/, "");

  const FORBIDDEN = /\b(DROP|DELETE|TRUNCATE|INSERT|UPDATE|ALTER|CREATE|GRANT|REVOKE|EXEC|EXECUTE|pg_sleep|pg_read_file)\b/i;
  if (FORBIDDEN.test(sql)) {
    throw new Error("SQL mengandung keyword yang tidak diizinkan.");
  }

  if (!/\bLIMIT\b/i.test(sql)) sql += ` LIMIT ${MAX_ROWS}`;

  return sql;
}

// ============================================================
//  OLLAMA — pakai /api/chat (bukan /api/generate)
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
        model: OLLAMA_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
        stream: false,
        options: {
          temperature:   0,
          top_p:         0.9,
          repeat_penalty: 1.1,
          num_predict:   1024,
          num_ctx:       4096,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
    }

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
//  GUARD HALLUCINATION — tulis_catatan
//  Keyword yang harus ada agar catatan dianggap relevan dengan DB
// ============================================================
const DB_RELEVANT_KEYWORDS = [
  // objek database
  "tabel", "table", "kolom", "column", "field", "index", "relasi", "join",
  "foreign key", "primary key", "query", "sql", "select", "view", "schema",
  // konvensi format nilai
  "=", "true", "false", "null", "artinya", "berarti", "maksudnya",
  "id", "kode", "slug", "flag", "status", "type", "role", "level",
  // nama tabel umum konstruksi
  "projects", "users", "vendors", "locations", "items", "stores", "stocks",
  "transactions", "orders", "employees", "contracts", "budgets",
  "roles", "permissions", "categories", "suppliers", "warehouses",
  // konvensi teknis
  "initial_store", "plu", "ext_code", "tenant_id", "created_at", "updated_at",
  "is_director", "is_active", "is_finance", "sort_order", "parent_id",
  // kata kerja DB
  "insert", "update", "delete", "truncate", "migrate", "seed",
  // kata penanda konvensi
  "konvensi", "relasi", "join ke", "foreign", "primary", "index pada",
];

// Kategori yang diizinkan untuk disimpan
const ALLOWED_KATEGORI = new Set(["konvensi", "relasi", "query", "lainnya"]);

/**
 * Cek apakah isi catatan relevan dengan konteks database.
 * Return true jika relevan, false jika tampak hallucination/off-topic.
 */
function isDbRelevantNote(catatan) {
  const lower = catatan.toLowerCase();
  return DB_RELEVANT_KEYWORDS.some((kw) => lower.includes(kw));
}


const CATATAN_KEYWORDS = [
  "catatan", "knowledge", "pengetahuan", "memory", "ingatan",
  "kamu ingat", "kamu tahu", "yang tersimpan", "catatan kamu",
  "knowledge base", "baca catatan", "lihat catatan", "tampilkan catatan",
  "sebutkan catatan", "apa yang kamu", "apa isi",
];

function isCatatanIntent(text) {
  const lower = text.toLowerCase();
  return CATATAN_KEYWORDS.some((kw) => lower.includes(kw));
}

// ============================================================
//  HELPER: Format output tanya_database
// ============================================================
// Batas karakter JSON output ke model — cegah context overflow
const MAX_JSON_CHARS = parseInt(process.env.MAX_JSON_CHARS || "4000");

function formatQueryResult({ tables, relationHints, sql, rows, totalRows }) {
  const truncatedRows = totalRows > MAX_ROWS;

  // Buat JSON, truncate jika terlalu panjang
  let jsonStr  = JSON.stringify(rows, null, 2);
  let jsonNote = "";
  if (jsonStr.length > MAX_JSON_CHARS) {
    // Potong dan coba parse sampai baris valid
    jsonStr  = jsonStr.slice(0, MAX_JSON_CHARS);
    jsonNote = `\n⚠️  Output dipotong (${rows.length} baris, ${MAX_JSON_CHARS} chars). Gunakan filter kolom/WHERE untuk data lebih spesifik.`;
  }

  const lines = [
    `📋 Tabel   : ${tables.join(", ")}`,
    relationHints.length ? `🔗 Relasi   : ${relationHints.join(" | ")}` : null,
    `🔍 SQL     : ${sql}`,
    ``,
    truncatedRows
      ? `⚠️  Ditampilkan ${MAX_ROWS} dari ${totalRows} baris`
      : `✅ ${rows.length} baris ditemukan`,
    jsonStr + jsonNote,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

// ============================================================
//  MCP SERVER
// ============================================================
const server = new Server(
  { name: "tuf-ai-analyst", version: "5.2.0" },
  { capabilities: { tools: {} } }
);

// ── Tool Definitions ─────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── 1. daftar_tabel ──────────────────────────────────────
    {
      name: "daftar_tabel",
      description: [
        "Tampilkan semua nama tabel di database.",
        "Gunakan HANYA jika user secara eksplisit bertanya 'tabel apa saja yang ada' atau 'list semua tabel'.",
        "JANGAN panggil tool ini sebelum tanya_database — tanya_database sudah otomatis memilih tabel yang tepat.",
        "JANGAN panggil bersamaan dengan tool lain.",
      ].join(" "),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },

    // ── 2. lihat_struktur_tabel ───────────────────────────────
    {
      name: "lihat_struktur_tabel",
      description: [
        "Tampilkan struktur kolom (nama + tipe data) dari satu atau beberapa tabel.",
        "Gunakan setelah daftar_tabel untuk memahami kolom yang tersedia sebelum query.",
        "Contoh: 'lihat struktur tabel locations' atau 'lihat struktur tabel locations, stores'.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          nama_tabel: {
            type: "string",
            description: "Satu atau beberapa nama tabel dipisah koma. Contoh: 'locations' atau 'locations, stores'",
          },
        },
        required: ["nama_tabel"],
        additionalProperties: false,
      },
    },

    // ── 3. tanya_database ─────────────────────────────────────
    {
      name: "tanya_database",
      description: [
        "Ambil data dari tabel PostgreSQL menggunakan pertanyaan natural language.",
        "Cocok untuk: menampilkan produk, user, transaksi, laporan, stok, dsb.",
        "JANGAN gunakan untuk membaca catatan/knowledge — gunakan baca_catatan.",
        "Input berupa pertanyaan Bahasa Indonesia, BUKAN SQL mentah.",
        "Contoh BENAR: 'tampilkan 5 vendor terbaru', 'berapa total stok item di gudang A'.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          pertanyaan: {
            type: "string",
            description: "Pertanyaan natural language tentang data di database.",
          },
        },
        required: ["pertanyaan"],
        additionalProperties: false,
      },
    },

    // ── 4. tulis_catatan ──────────────────────────────────────
    {
      name: "tulis_catatan",
      description: [
        "Simpan catatan tentang database: konvensi kolom, relasi tabel, atau contoh query.",
        "HANYA gunakan jika user SECARA EKSPLISIT meminta menyimpan catatan.",
        "DILARANG menyimpan informasi umum, fakta non-database, atau jawaban karangan.",
        "DILARANG dipanggil otomatis saat user hanya bertanya — baca_catatan dulu, jangan tulis.",
        "Wajib isi field user_confirmed=true untuk konfirmasi permintaan dari user.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          catatan: {
            type: "string",
            description: "Catatan tentang database yang ingin disimpan.",
          },
          kategori: {
            type: "string",
            enum: ["konvensi", "relasi", "query", "lainnya"],
            description: "konvensi = nama kolom, relasi = join antar tabel, query = contoh SQL benar, lainnya = info DB umum",
          },
          user_confirmed: {
            type: "boolean",
            description: "Set true jika user secara eksplisit meminta menyimpan catatan ini. WAJIB diisi.",
          },
        },
        required: ["catatan", "kategori", "user_confirmed"],
        additionalProperties: false,
      },
    },

    // ── 5. baca_catatan ───────────────────────────────────────
    {
      name: "baca_catatan",
      description: [
        "Baca semua catatan/memory yang tersimpan di knowledge base.",
        "Trigger: 'tampilkan catatan', 'lihat catatan', 'baca catatan', 'apa yang kamu ingat',",
        "'tampilkan pengetahuan kamu', 'sebutkan catatan', 'apa isi memory kamu'.",
        "BUKAN untuk query data dari database — gunakan tanya_database untuk itu.",
        "Tidak memerlukan parameter apapun.",
      ].join(" "),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },

    // ── 6. perbarui_catatan ───────────────────────────────────
    {
      name: "perbarui_catatan",
      description: "Perbaiki atau ganti teks spesifik di dalam catatan yang salah.",
      inputSchema: {
        type: "object",
        properties: {
          teks_lama: {
            type: "string",
            description: "Potongan teks yang salah dan ingin diganti (case-sensitive).",
          },
          teks_baru: {
            type: "string",
            description: "Teks baru yang benar sebagai pengganti.",
          },
        },
        required: ["teks_lama", "teks_baru"],
        additionalProperties: false,
      },
    },

    // ── 7. hapus_semua_catatan ────────────────────────────────
    {
      name: "hapus_semua_catatan",
      description: "Reset seluruh isi knowledge base jika sudah terlalu penuh atau banyak data tidak relevan.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },

    // ── 8. refresh_cache ─────────────────────────────────────
    {
      name: "refresh_cache",
      description: [
        "Invalidasi cache schema database dan muat ulang daftar tabel dari PostgreSQL.",
        "Gunakan jika ada tabel baru yang ditambahkan setelah server berjalan,",
        "atau jika struktur tabel berubah dan hasil query tidak sesuai.",
      ].join(" "),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },

    // ── 9. list_dokumen ───────────────────────────────────────
    {
      name: "list_dokumen",
      description: [
        "Tampilkan semua file dokumen .md yang tersedia di folder docs.",
        "Gunakan jika user tanya 'dokumen apa saja yang ada', 'peraturan apa yang tersimpan',",
        "'file apa yang bisa dibaca', atau sebelum cari_dokumen jika tidak tahu keyword.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          allowed_folders: {
            type: "array",
            items: { type: "string" },
            description: "Folder yang boleh diakses. Kosong = semua folder.",
          },
        },
        additionalProperties: false,
      },
    },

    // ── 10. cari_dokumen ──────────────────────────────────────
    {
      name: "cari_dokumen",
      description: [
        "Cari keyword di semua file dokumen .md (peraturan, SOP, kebijakan perusahaan).",
        "Gunakan untuk pertanyaan tentang: peraturan, kebijakan, SOP, prosedur, hak, kewajiban.",
        "Contoh trigger: 'peraturan cuti', 'apa itu reimburse', 'prosedur kasir',",
        "'kebijakan lembur', 'syarat kenaikan gaji', 'aturan perusahaan tentang X'.",
        "Return potongan teks relevan dari file yang cocok.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "Kata kunci yang dicari. Contoh: 'cuti', 'lembur', 'reimburse'",
          },
          allowed_folders: {
            type: "array",
            items: { type: "string" },
            description: "Folder yang boleh diakses. Kosong = semua folder.",
          },
        },
        required: ["keyword"],
        additionalProperties: false,
      },
    },

    // ── 11. baca_dokumen ──────────────────────────────────────
    {
      name: "baca_dokumen",
      description: [
        "Baca isi lengkap satu file dokumen .md berdasarkan path relatif.",
        "Gunakan setelah list_dokumen atau cari_dokumen untuk membaca file secara penuh.",
        "Contoh path: 'hr/cuti.md', 'operasional/sop-kasir.md'.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path relatif file dari folder docs. Contoh: 'hr/cuti.md'",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
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
    // ── daftar_tabel ────────────────────────────────────────
    if (toolName === "daftar_tabel") {
      const tables = await getTableNames();
      return {
        content: [{
          type: "text",
          text: `📦 ${tables.length} tabel tersedia:\n${tables.map((t) => `  - ${t}`).join("\n")}`,
        }],
      };
    }

    // ── lihat_struktur_tabel ─────────────────────────────────
    if (toolName === "lihat_struktur_tabel") {
      const allTables   = await getTableNames();
      const inputTables = (args.nama_tabel || "")
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => allTables.includes(t));

      if (inputTables.length === 0) {
        return {
          content: [{
            type: "text",
            text: `❌ Tabel tidak ditemukan.\nDaftar tabel tersedia: ${allTables.slice(0, 30).join(", ")}`,
          }],
        };
      }

      const placeholders = inputTables.map((_, i) => `$${i + 1}`).join(",");
      const res = await pool.query(
        `SELECT table_name, column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name IN (${placeholders})
         ORDER BY table_name, ordinal_position`,
        inputTables
      );

      const grouped = {};
      for (const row of res.rows) {
        if (!grouped[row.table_name]) grouped[row.table_name] = [];
        grouped[row.table_name].push(`${row.column_name} (${row.data_type})`);
      }

      const lines = Object.entries(grouped).map(
        ([tabel, cols]) => `📋 ${tabel}:\n${cols.map((c) => `  - ${c}`).join("\n")}`
      );
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }

    // ── tulis_catatan ────────────────────────────────────────
    if (toolName === "tulis_catatan") {
      const catatan        = (args.catatan  || "").trim();
      const kategori       = (args.kategori || "lainnya").toLowerCase();
      const userConfirmed  = args.user_confirmed === true;

      // ── Guard 1: field wajib ─────────────────────────────
      if (!catatan) {
        return { content: [{ type: "text", text: "❌ Catatan tidak boleh kosong." }] };
      }

      // ── Guard 2: user harus konfirmasi eksplisit ─────────
      if (!userConfirmed) {
        log("GUARD", `tulis_catatan ditolak — user_confirmed=false. Isi: "${catatan.slice(0, 80)}"`);
        return {
          content: [{
            type: "text",
            text: "⛔ Catatan tidak disimpan.\n" +
                  "Tool ini hanya boleh dipanggil jika user secara eksplisit meminta menyimpan catatan.\n" +
                  "Jangan simpan catatan secara otomatis.",
          }],
        };
      }

      // ── Guard 3: kategori harus valid ────────────────────
      if (!ALLOWED_KATEGORI.has(kategori)) {
        log("GUARD", `tulis_catatan ditolak — kategori tidak valid: "${kategori}"`);
        return {
          content: [{
            type: "text",
            text: `❌ Kategori '${kategori}' tidak diizinkan.\nGunakan: konvensi, relasi, query, atau lainnya.`,
          }],
        };
      }

      // ── Guard 4: isi catatan harus relevan dengan DB ─────
      if (!isDbRelevantNote(catatan)) {
        log("GUARD", `tulis_catatan ditolak — tidak relevan DB: "${catatan.slice(0, 100)}"`);
        return {
          content: [{
            type: "text",
            text: "⛔ Catatan ditolak — isinya tidak terdeteksi relevan dengan database.\n" +
                  "Catatan hanya untuk: konvensi kolom, relasi tabel, atau contoh query SQL.\n" +
                  "Jangan simpan informasi umum yang tidak berkaitan dengan database.",
          }],
        };
      }

      // ── Simpan catatan ───────────────────────────────────
      const timestamp     = new Date().toISOString().split("T")[0];
      const entry         = `\n- [${timestamp}] ${catatan}`;
      let   content       = await readFile(KNOWLEDGE_FILE, "utf8");
      const sectionHeader = `## ${kategori}`;

      if (!content.includes(sectionHeader)) content += `\n${sectionHeader}\n`;
      content = content.replace(sectionHeader, `${sectionHeader}${entry}`);

      await safeWriteKnowledge(content);
      log("KNOWLEDGE", `Tersimpan di [${kategori}]: ${catatan}`);
      return { content: [{ type: "text", text: `✅ Berhasil disimpan di kategori '${kategori}'.` }] };
    }

    // ── baca_catatan ─────────────────────────────────────────
    if (toolName === "baca_catatan") {
      if (!knowledgeCache || knowledgeCache.trim().length < 20) {
        return {
          content: [{ type: "text", text: "📭 Knowledge base masih kosong. Gunakan 'tulis_catatan' untuk mengisi." }],
        };
      }

      // Hanya tampilkan section yang punya isi
      const sections       = knowledgeCache.split(/^## /m).filter(Boolean);
      const filledSections = sections
        .map((s) => s.trim())
        .filter((s) => s.split("\n").slice(1).some((l) => l.trim() !== ""))
        .map((s) => `## ${s}`);

      if (filledSections.length === 0) {
        return {
          content: [{ type: "text", text: "📭 Knowledge base ada tapi semua section kosong." }],
        };
      }

      const output = filledSections.join("\n\n");
      log("KNOWLEDGE", `Mengembalikan ${filledSections.length} section (${output.length} chars)`);
      return {
        content: [{
          type: "text",
          text: `📚 Catatan yang tersimpan:\n\n${output}\n\n(Info tidak ada di sini = belum pernah dicatat.)`,
        }],
      };
    }

    // ── perbarui_catatan ─────────────────────────────────────
    if (toolName === "perbarui_catatan") {
      const teksLama = (args.teks_lama || "").trim();
      const teksBaru = (args.teks_baru || "").trim();

      if (!teksLama || !teksBaru) {
        return { content: [{ type: "text", text: "❌ teks_lama dan teks_baru tidak boleh kosong." }] };
      }

      const content = await readFile(KNOWLEDGE_FILE, "utf8");
      if (!content.includes(teksLama)) {
        return { content: [{ type: "text", text: "❌ Teks lama tidak ditemukan (case-sensitive)." }] };
      }

      const newContent = content.replace(teksLama, teksBaru);
      await safeWriteKnowledge(newContent);
      log("KNOWLEDGE", `Diperbarui: "${teksLama}" → "${teksBaru}"`);
      return { content: [{ type: "text", text: "✅ Catatan berhasil diperbarui." }] };
    }

    // ── hapus_semua_catatan ──────────────────────────────────
    if (toolName === "hapus_semua_catatan") {
      await safeWriteKnowledge(KNOWLEDGE_TEMPLATE);
      log("KNOWLEDGE", "Seluruh catatan direset.");
      return {
        content: [{ type: "text", text: "🗑️ Semua catatan dihapus. Knowledge base kembali ke template awal." }],
      };
    }

    // ── refresh_cache ────────────────────────────────────────
    if (toolName === "refresh_cache") {
      invalidateAllCaches();
      const tables = await getTableNames();
      await getFKRelations();
      return {
        content: [{
          type: "text",
          text: `✅ Cache diperbarui. ${tables.length} tabel dimuat ulang dari database.`,
        }],
      };
    }

    // ── tanya_database ───────────────────────────────────────
    if (toolName === "tanya_database") {
      let pertanyaan = (args.pertanyaan || "").trim();
      if (typeof pertanyaan === "object") {
        pertanyaan = pertanyaan.value ?? JSON.stringify(pertanyaan);
      }

      if (!pertanyaan) {
        return { content: [{ type: "text", text: "❌ Pertanyaan tidak boleh kosong." }] };
      }

      // ── Redirect jika model salah tool ───────────────────
      if (isCatatanIntent(pertanyaan)) {
        log("INTENT", `Redirect ke knowledge: "${pertanyaan}"`);
        if (!knowledgeCache || knowledgeCache.trim().length < 20) {
          return { content: [{ type: "text", text: "📭 Knowledge base masih kosong." }] };
        }
        try {
          const answer = await askLLM(
            "Kamu adalah asisten yang menjawab berdasarkan catatan tersimpan. " +
            "Jika tidak ada di catatan, katakan 'Tidak ada di catatan'.",
            `Catatan:\n${knowledgeCache}\n\nPertanyaan: "${pertanyaan}"`
          );
          return { content: [{ type: "text", text: answer }] };
        } catch {
          return { content: [{ type: "text", text: `📚 Catatan:\n\n${knowledgeCache}` }] };
        }
      }

      // ── Normalisasi SQL-like input ────────────────────────
      if (/^\s*(select|tampilkan\s+\*\s+dari|show\s+all\s+from)\s+/i.test(pertanyaan)) {
        const tableMatch = pertanyaan.match(/\b(?:from|table|tabel|dari\s+table|dari\s+tabel)\s+([a-z0-9_]+)/i);
        if (tableMatch) {
          pertanyaan = `tampilkan semua data dari tabel ${tableMatch[1]}`;
          log("NORMALIZE", `SQL-like → "${pertanyaan}"`);
        }
      }

      // ── STEP 1: Pilih tabel relevan ───────────────────────
      const allTables = await getTableNames();

      const knowledgeCtx = knowledgeCache.trim()
        ? `\nCatatan penting tentang database ini:\n${knowledgeCache}\n`
        : "";

      const step1Answer = await askLLM(
        `Kamu adalah database analyst. Jawab HANYA nama tabel yang relevan, dipisah koma, tanpa penjelasan.${knowledgeCtx}`,
        `Daftar tabel: ${allTables.join(", ")}\n\nPertanyaan: "${pertanyaan}"\n\nNama tabel yang diperlukan:`
      );

      let selectedTables = step1Answer
        .split(",")
        .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9_]/g, ""))
        .filter((t) => allTables.includes(t))
        .slice(0, 6);

      // Fallback: coba cocokkan dari teks pertanyaan
      if (selectedTables.length === 0) {
        selectedTables = allTables
          .filter((t) => pertanyaan.toLowerCase().includes(t))
          .slice(0, 3);

        if (selectedTables.length === 0) {
          return {
            content: [{
              type: "text",
              text: `❌ Tidak ada tabel relevan untuk: "${pertanyaan}".\n` +
                    `Gunakan tool 'daftar_tabel' untuk melihat tabel yang tersedia.`,
            }],
          };
        }
        log("STEP1-FALLBACK", `Tabel dari regex: ${selectedTables.join(", ")}`);
      }
      log("STEP1", `Tabel terpilih: ${selectedTables.join(", ")}`);

      // ── STEP 2: Load schema + relasi ──────────────────────
      const schemas       = await getSchemaForTables(selectedTables);
      const relationHints = await getRelationHints(selectedTables);

      const schemaContext = selectedTables
        .map((t) => `${t}(${schemas[t]})`)
        .join("\n");
      const relationContext = relationHints.length
        ? `\nRelasi:\n${relationHints.map((r) => `  - ${r}`).join("\n")}`
        : "";

      // ── STEP 3: Generate SQL ──────────────────────────────
      const sqlRaw = await askLLM(
        [
          "[DB: PostgreSQL]",
          knowledgeCtx,
          "Tugas: hasilkan SQL SELECT yang valid.",
          "ATURAN KETAT:",
          "1. Respons hanya berisi SQL murni, dimulai langsung dengan SELECT atau WITH.",
          "2. DILARANG menulis penjelasan, kalimat, atau komentar apapun.",
          "3. Hanya gunakan kolom yang ada di skema.",
          "4. Gunakan JOIN sesuai relasi yang diberikan.",
          "",
          "Contoh OUTPUT BENAR:",
          "SELECT id, name FROM vendors LIMIT 50",
          "",
          "Contoh OUTPUT SALAH (jangan lakukan):",
          "Berikut querynya: SELECT id, name FROM vendors",
        ].join("\n"),
        [
          `Skema:\n${schemaContext}${relationContext}`,
          `\nPertanyaan: "${pertanyaan}"`,
          "\nSQL:",
        ].join("\n")
      );

      let sql;
      try {
        sql = validateAndCleanSQL(sqlRaw);
      } catch (validationErr) {
        return { content: [{ type: "text", text: `❌ ${validationErr.message}` }] };
      }

      // ── STEP 4: Eksekusi query ────────────────────────────
      log("EXEC", sql);
      let dbResult;
      try {
        dbResult = await pool.query(sql);
      } catch (dbErr) {
        // Error message spesifik dengan kode PostgreSQL
        const isDbError = dbErr.code && /^[24578]/.test(dbErr.code);
        const errMsg = isDbError
          ? `❌ Database error (${dbErr.code}): ${dbErr.message}\n🔍 SQL: ${sql}`
          : `❌ Query gagal: ${dbErr.message}\n🔍 SQL: ${sql}`;
        return { content: [{ type: "text", text: errMsg }] };
      }

      const allRows    = sanitizeRows(dbResult.rows);
      const totalRows  = allRows.length;
      const rows       = allRows.slice(0, MAX_ROWS);

      return {
        content: [{
          type: "text",
          text: formatQueryResult({ tables: selectedTables, relationHints, sql, rows, totalRows }),
        }],
      };
    }

    // ── list_dokumen ─────────────────────────────────────────
    if (toolName === "list_dokumen") {
      const allowedFolders = args.allowed_folders || [];
      const allFiles = await scanMarkdownFiles(DOCS_DIR);
      const files = allowedFolders.length > 0
        ? allFiles.filter(f => {
            const rel = f.replace(DOCS_DIR, "").replace(/\\/g, "/").replace(/^\//, "");
            return allowedFolders.some(folder => rel.startsWith(folder + "/") || rel.startsWith(folder));
          })
        : allFiles;

      if (files.length === 0) {
        return {
          content: [{ type: "text", text: "📭 Belum ada dokumen yang bisa diakses." }],
        };
      }
      const list = files.map((f) => {
        const rel = f.replace(DOCS_DIR, "").replace(/\\/g, "/").replace(/^\//, "");
        return `  - ${rel}`;
      });
      return {
        content: [{ type: "text", text: `📁 ${files.length} dokumen tersedia:\n${list.join("\n")}` }],
      };
    }

    // ── cari_dokumen ─────────────────────────────────────────
    if (toolName === "cari_dokumen") {
      const keyword        = (args.keyword || "").trim();
      const allowedFolders = args.allowed_folders || [];

      if (!keyword) {
        return { content: [{ type: "text", text: "❌ Keyword tidak boleh kosong." }] };
      }

      let results = await searchDocs(keyword);

      // Filter hasil berdasarkan allowed_folders
      if (allowedFolders.length > 0) {
        results = results.filter(r =>
          allowedFolders.some(folder => r.file.startsWith(folder + "/") || r.file.startsWith(folder))
        );
      }
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `🔍 Tidak ditemukan dokumen yang mengandung keyword "${keyword}".` }],
        };
      }

      const output = results.map(({ file, matches }) =>
        `📄 ${file}:\n${matches.map((m) => `  > ${m.replace(/\n/g, "\n    ")}`).join("\n")}`
      ).join("\n\n");

      log("DOCS", `cari_dokumen("${keyword}") → ${results.length} file cocok`);
      return {
        content: [{ type: "text", text: `🔍 Hasil pencarian "${keyword}":\n\n${output}` }],
      };
    }

    // ── baca_dokumen ─────────────────────────────────────────
    if (toolName === "baca_dokumen") {
      const relPath = (args.path || "").trim().replace(/\\/g, "/");
      if (!relPath) {
        return { content: [{ type: "text", text: "❌ Path tidak boleh kosong." }] };
      }

      try {
        const content = await readDocFile(relPath);
        log("DOCS", `baca_dokumen("${relPath}") → ${content.length} chars`);
        return {
          content: [{ type: "text", text: `📄 ${relPath}:\n\n${content}` }],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `❌ ${e.message}: ${relPath}\nGunakan list_dokumen untuk melihat file yang tersedia.` }],
        };
      }
    }

    // ── Fallback ─────────────────────────────────────────────
    return {
      content: [{ type: "text", text: `❌ Tool '${toolName}' tidak dikenal.` }],
    };

  } catch (err) {
    log("ERROR", `${toolName}: ${err.message}`);
    return {
      content: [{ type: "text", text: `❌ Internal error: ${err.message}` }],
    };
  }
});

// ============================================================
//  STARTUP
// ============================================================
await loadKnowledge();

try {
  await getTableNames();
  await getFKRelations();
  log("READY", `tuf-ai-analyst v5.2.0 — model: ${OLLAMA_MODEL}`);
} catch (err) {
  log("ERROR", `Gagal koneksi database saat startup: ${err.message}`);
  log("ERROR", "Pastikan konfigurasi DB di .env sudah benar.");
  process.exit(1);
}

const transport = new StdioServerTransport();
await server.connect(transport);