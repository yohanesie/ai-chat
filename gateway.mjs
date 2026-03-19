/**
 * gateway.mjs — AI Chat Gateway v2.0.0
 *
 * HTTP wrapper untuk MCP server + Ollama.
 * Jalankan: node gateway.mjs
 *
 * Endpoints:
 *   POST /api/chat          — kirim pesan, dapat balasan AI
 *   GET  /api/sessions      — list semua session aktif
 *   DELETE /api/sessions/:id — hapus session (reset history)
 *   GET  /api/health        — cek status server
 *
 * Role yang didukung (field "role" di request body):
 *   cs      — customer service, akses terbatas (default tanpa login)
 *   spv     — supervisor, akses internal penuh
 *   finance — tim finance, fokus data keuangan
 */

import express              from "express";
import { readFile }         from "fs/promises";
import { existsSync, writeFileSync } from "fs";
import { fileURLToPath }    from "url";
import { dirname, join }    from "path";
import { Client }           from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ============================================================
//  ENV LOADER
// ============================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

async function loadEnv() {
  const envPath = join(__dirname, ".env");
  if (!existsSync(envPath)) return;
  const lines = (await readFile(envPath, "utf8")).split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}
await loadEnv();

const OLLAMA_URL   = process.env.OLLAMA_URL   || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";
const PORT         = parseInt(process.env.GATEWAY_PORT || "3000");
const MCP_SCRIPT   = join(__dirname, "index.mjs");

// Batas history per session (hemat context window)
const MAX_HISTORY  = parseInt(process.env.MAX_HISTORY || "20");
const NUM_CTX      = parseInt(process.env.NUM_CTX     || "4096");

// Timeout session idle sebelum dihapus (default 30 menit)
const SESSION_TTL  = parseInt(process.env.SESSION_TTL || "1800000");

function log(tag, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}][${tag}] ${msg}`);
}

// ============================================================
//  ROLE CONFIG — system prompt + akses per role
// ============================================================

const ATURAN_UMUM = `
BAHASA: Selalu jawab dalam Bahasa Indonesia. DILARANG menjawab dalam bahasa lain apapun.

ATURAN KONTEKS PERCAKAPAN:
- Kamu memiliki akses ke history percakapan sebelumnya
- Kata ganti "itu", "tadi", "tersebut", "project itu", "user itu" → merujuk ke data yang baru dibahas
- JANGAN minta konfirmasi jika konteks sudah jelas dari history
- Contoh: setelah bahas project X, user tanya "user yang terdaftar ke project itu" → query users di project X

ATURAN TOOL — WAJIB DIPATUHI:
[TANYA_DATABASE]
- WAJIB dipanggil untuk SETIAP pertanyaan tentang data, termasuk pertanyaan lanjutan
- TIDAK BOLEH skip tool meski topik sudah dibahas sebelumnya di history
- Gunakan konteks dari history untuk tentukan filter WHERE yang tepat
- LANGSUNG panggil tanpa daftar_tabel dulu

[LIHAT_STRUKTUR_TABEL] Gunakan jika user tanya struktur/kolom tabel.
[DAFTAR_TABEL] HANYA jika user tanya "tabel apa saja yang ada".
[BACA_CATATAN] Untuk pertanyaan tentang catatan/memory tersimpan.
[TULIS_CATATAN] HANYA jika user eksplisit minta simpan catatan.
[DOKUMEN — cari_dokumen, baca_dokumen, list_dokumen]
  - SETIAP pertanyaan peraturan/kebijakan WAJIB panggil cari_dokumen
  - File .md adalah SATU-SATUNYA sumber kebenaran untuk peraturan

ATURAN OUTPUT:
- Tampilkan data aktual dari hasil tool, format sebagai tabel atau list yang rapi
- DILARANG jawab dari ingatan sendiri tanpa tool
- DILARANG menambahkan catatan atau disclaimer yang tidak ada di hasil tool
- DILARANG membatasi tampilan data dengan alasan "kerahasiaan" kecuali diperintahkan

LARANGAN MUTLAK:
- DILARANG skip tool call untuk pertanyaan lanjutan — SETIAP pertanyaan data WAJIB query ulang
- DILARANG mensimulasikan atau mengarang hasil tool call dalam teks
- DILARANG menulis format seperti {NAMA_TOOL: {...}} di dalam jawaban
- DILARANG mengklaim berhasil melakukan sesuatu jika tool tidak dipanggil
- DILARANG mengarang nama, angka, atau data yang tidak berasal dari database
- Jika tool tidak tersedia untuk role kamu → katakan "Fitur ini tidak tersedia untuk role Anda"`;

// Tools yang bisa dipakai per role
// null = semua tools boleh, array = whitelist tools
const READ_ONLY_TOOLS  = ["tanya_database", "lihat_struktur_tabel", "daftar_tabel", "baca_catatan", "list_dokumen", "cari_dokumen", "baca_dokumen"]
const WRITE_TOOLS      = ["tulis_catatan", "perbarui_catatan", "hapus_semua_catatan", "refresh_cache"]
const ALL_TOOLS        = [...READ_ONLY_TOOLS, ...WRITE_TOOLS]
const ROLE_CONFIG = {

  // ── Customer Service — default tanpa login ──────────────────
  cs: {
    systemPrompt: `Kamu adalah customer service AI yang ramah dan profesional untuk perusahaan konstruksi NKS.
Bantu customer dengan pertanyaan seputar produk, layanan, status proyek, dan kebijakan umum.
Jawab dalam Bahasa Indonesia yang hangat dan mudah dipahami.
Jika tidak bisa menjawab, sarankan customer untuk menghubungi tim CS kami.
${ATURAN_UMUM}
BATASAN AKSES:
- HANYA boleh akses tabel: projects, vendors
- DILARANG tampilkan data keuangan, gaji, atau data internal sensitif
- DILARANG akses dokumen internal HR atau operasional
- Jika ditanya di luar kapasitas → "Untuk informasi lebih lanjut, silakan hubungi tim CS kami"`,
    allowedTables: ["projects", "vendors"],
    allowedDocs:   ["faq", "policy"],
    allowedTools:  READ_ONLY_TOOLS,
    maxHistory:    10,
    toolRestrictionMsg: "Kamu TIDAK memiliki akses untuk menulis, mengubah, atau menghapus catatan. Jika diminta, katakan: 'Maaf, fitur ini hanya tersedia untuk Admin.'",
  },

  // ── Supervisor — baca semua, tidak bisa ubah knowledge ─────
  spv: {
    systemPrompt: `Kamu adalah AI analyst internal untuk level Supervisor perusahaan konstruksi NKS.
Kamu bisa akses semua data database dan dokumen perusahaan sesuai kebutuhan operasional.
Jawab dalam Bahasa Indonesia yang profesional dan ringkas.
${ATURAN_UMUM}`,
    allowedTables: null,
    allowedDocs:   null,
    allowedTools:  READ_ONLY_TOOLS,
    maxHistory:    20,
    toolRestrictionMsg: "Kamu TIDAK memiliki akses untuk menulis, mengubah, atau menghapus catatan. Jika diminta, katakan: 'Maaf, fitur ini hanya tersedia untuk Admin.'",
  },

  // ── Finance — baca semua, tidak bisa ubah knowledge ────────
  finance: {
    systemPrompt: `Kamu adalah AI analyst untuk tim Finance perusahaan konstruksi NKS.
Fokus pada analisis data keuangan, budget, realisasi, dan laporan.
Jawab dalam Bahasa Indonesia yang formal, akurat, dan detail.
${ATURAN_UMUM}
FOKUS AKSES:
- Prioritaskan tabel: transactions, budgets, contracts, projects, rab_headers, rab_items, realization_reports
- Untuk kalkulasi profit/loss, selalu gunakan data aktual dari database`,
    allowedTables: null,
    allowedDocs:   null,
    allowedTools:  READ_ONLY_TOOLS,
    maxHistory:    20,
    toolRestrictionMsg: "Kamu TIDAK memiliki akses untuk menulis, mengubah, atau menghapus catatan. Jika diminta, katakan: 'Maaf, fitur ini hanya tersedia untuk Admin.'",
  },

  // ── Director — baca semua, tidak bisa ubah knowledge ───────
  director: {
    systemPrompt: `Kamu adalah AI analyst untuk level Direktur perusahaan konstruksi NKS.
Berikan analisis ringkas dan insight strategis dari data yang ada.
Jawab dalam Bahasa Indonesia yang eksekutif — singkat, padat, dan actionable.
${ATURAN_UMUM}`,
    allowedTables: null,
    allowedDocs:   null,
    allowedTools:  READ_ONLY_TOOLS,
    maxHistory:    20,
    toolRestrictionMsg: "Kamu TIDAK memiliki akses untuk menulis, mengubah, atau menghapus catatan. Jika diminta, katakan: 'Maaf, fitur ini hanya tersedia untuk Admin.'",
  },

  // ── Admin — akses penuh termasuk kelola knowledge ──────────
  admin: {
    systemPrompt: `Kamu adalah AI analyst untuk Admin sistem perusahaan konstruksi NKS.
Kamu punya akses penuh termasuk mengelola knowledge base dan konfigurasi sistem.
Jawab dalam Bahasa Indonesia yang teknis dan detail.
${ATURAN_UMUM}`,
    allowedTables: null,
    allowedDocs:   null,
    allowedTools:  ALL_TOOLS,  // Admin bisa semua termasuk tulis/hapus knowledge
    maxHistory:    20,
  },
};

// Default role jika tidak ada atau tidak dikenal
const DEFAULT_ROLE = "cs";

function getRoleConfig(role) {
  const config = ROLE_CONFIG[role] || ROLE_CONFIG[DEFAULT_ROLE];
  // Inject restriction message ke system prompt jika ada
  if (config.toolRestrictionMsg) {
    return {
      ...config,
      systemPrompt: config.systemPrompt + `

BATASAN ROLE:
${config.toolRestrictionMsg}`,
    };
  }
  return config;
}

// Validasi tabel — filter jika role punya allowedTables
function isTableAllowed(tableName, allowedTables) {
  if (!allowedTables) return true;
  return allowedTables.includes(tableName.toLowerCase());
}

// Validasi tool — filter berdasarkan allowedTools role
function isToolAllowed(toolName, allowedTools) {
  if (!allowedTools) return true;
  return allowedTools.includes(toolName);
}

// ============================================================
//  SESSION MANAGER
// ============================================================
/**
 * Session menyimpan history percakapan per user.
 * Format history mengikuti Ollama messages format:
 *   { role: "user"|"assistant"|"tool", content: string }
 */
class SessionManager {
  constructor() {
    /** @type {Map<string, {history: Array, lastActive: number}>} */
    this.sessions = new Map();
    // Cleanup session idle setiap 5 menit
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  get(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) session.lastActive = Date.now();
    return session;
  }

  getOrCreate(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        history:    [],
        lastActive: Date.now(),
        createdAt:  Date.now(),
      });
      log("SESSION", `Baru: ${sessionId}`);
    }
    return this.get(sessionId);
  }

  addMessage(sessionId, role, content) {
    const session = this.getOrCreate(sessionId);
    session.history.push({ role, content: String(content) });

    // Trim history jika melebihi batas — buang pesan paling lama
    // tapi selalu pertahankan pesan pertama (konteks awal)
    if (session.history.length > MAX_HISTORY) {
      session.history = session.history.slice(session.history.length - MAX_HISTORY);
      log("SESSION", `History di-trim ke ${MAX_HISTORY} pesan: ${sessionId}`);
    }
  }

  delete(sessionId) {
    const existed = this.sessions.has(sessionId);
    this.sessions.delete(sessionId);
    return existed;
  }

  list() {
    const now = Date.now();
    return [...this.sessions.entries()].map(([id, s]) => ({
      sessionId:    id,
      messageCount: s.history.length,
      idleMinutes:  Math.floor((now - s.lastActive) / 60000),
      createdAt:    new Date(s.createdAt).toISOString(),
    }));
  }

  cleanup() {
    const now     = Date.now();
    let   removed = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.lastActive > SESSION_TTL) {
        this.sessions.delete(id);
        removed++;
      }
    }
    if (removed > 0) log("SESSION", `Cleanup: ${removed} session idle dihapus`);
  }
}

const sessions = new SessionManager();

// ============================================================
//  MCP CLIENT MANAGER
//  Satu MCP client per proses (singleton) — lebih efisien
//  daripada spawn baru per request
// ============================================================
class McpClientManager {
  constructor() {
    this.client    = null;
    this.tools     = [];
    this.connected = false;
  }

  async connect() {
    if (this.connected) return;

    log("MCP", `Menghubungkan ke ${MCP_SCRIPT}...`);

    const transport = new StdioClientTransport({
      command: "node",
      args:    [MCP_SCRIPT],
    });

    this.client = new Client(
      { name: "ai-gateway", version: "1.0.0" },
      { capabilities: {} }
    );

    await this.client.connect(transport);

    // Load daftar tools dari MCP server
    const result = await this.client.listTools();
    this.tools   = result.tools;
    this.connected = true;

    log("MCP", `Terhubung. ${this.tools.length} tools tersedia: ${this.tools.map(t => t.name).join(", ")}`);
  }

  async callTool(name, args) {
    if (!this.connected) throw new Error("MCP belum terhubung");
    const result = await this.client.callTool({ name, arguments: args });
    return result.content?.[0]?.text ?? "";
  }

  /** Convert MCP tools ke format Ollama tools, filter by allowedTools */
  getOllamaTools(allowedTools = null) {
    const tools = allowedTools
      ? this.tools.filter(t => allowedTools.includes(t.name))
      : this.tools;

    return tools.map((t) => ({
      type: "function",
      function: {
        name:        t.name,
        description: t.description,
        parameters:  t.inputSchema,
      },
    }));
  }
}

const mcp = new McpClientManager();

// ============================================================
//  OLLAMA CHAT — dengan tool call loop
// ============================================================
async function chatWithTools(messages, roleConfig = {}) {
  // Kirim HANYA tools yang diizinkan ke model
  // Dengan begitu model tidak tahu tool lain ada — tidak bisa simulate
  const ollamaTools = mcp.getOllamaTools(roleConfig.allowedTools || null);
  log("AUTH", `Role ${roleConfig._role || 'unknown'} — ${ollamaTools.length} tools aktif: ${ollamaTools.map(t=>t.function.name).join(', ')}`);
  const allMessages  = [...messages];

  // Loop maksimal 5 iterasi untuk cegah infinite tool call
  for (let iter = 0; iter < 5; iter++) {
    log("DEBUG", `Iter ${iter+1} — ${allMessages.length} messages (last: ${allMessages[allMessages.length-1]?.role})`);

    // Timeout per request 60 detik
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 120_000);

    let res;
    try {
      res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        signal:  controller.signal,
        body: JSON.stringify({
          model:    OLLAMA_MODEL,
          messages: allMessages,
          tools:    ollamaTools,
          stream:   false,
          options: {
            temperature:    0,
            num_ctx:        NUM_CTX,
            num_predict:    1024,   // naikkan agar cukup untuk output JSON data
            repeat_penalty: 1.1,
          },
        }),
      });
    } catch (err) {
      if (err.name === "AbortError") throw new Error("Model timeout (>120 detik). Coba pertanyaan lebih spesifik atau kurangi MAX_ROWS di .env");
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const msg  = data.message;

    // ── Guard: reply kosong tapi tidak ada tool call ──────────
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const hasContent   = msg.content && msg.content.trim().length > 0;

    if (!hasToolCalls && !hasContent) {
      log("WARN", `Iter ${iter+1}: model return kosong — retry dengan hint`);
      allMessages.push({
        role:    "user",
        content: "Tolong jawab pertanyaan saya. Gunakan tool yang tersedia jika diperlukan.",
      });
      continue;
    }

    // ── Guard: model jawab tanpa tool padahal pertanyaan tentang data ──
    // Deteksi pertanyaan lanjutan yang butuh tool tapi model skip
    if (!hasToolCalls && hasContent && iter === 0) {
      const lastUserMsg = [...allMessages].reverse().find(m => m.role === "user")?.content || "";
      const isDataQuery = /\b(siapa|berapa|tampilkan|lihat|daftar|cari|user|data|project|vendor|nilai|total|list|ada|terdaftar|assigned|member)\b/i.test(lastUserMsg);
      const hasDbTool   = ollamaTools.some(t => t.function.name === "tanya_database");

      if (isDataQuery && hasDbTool) {
        log("FORCE", `Model skip tool untuk pertanyaan data — paksa tanya_database`);
        allMessages.push({ role: "assistant", content: msg.content });
        allMessages.push({
          role:    "user",
          content: `Kamu harus memanggil tool tanya_database untuk menjawab pertanyaan ini. Jangan jawab dari ingatan. Panggil tool sekarang.`,
        });
        continue;
      }
    }

    // Tidak ada tool call → selesai, return jawaban
    if (!hasToolCalls) {
      return { reply: msg.content, messages: allMessages };
    }

    // Ada tool call → eksekusi via MCP lalu lanjut loop
    allMessages.push(msg);

    for (const tc of msg.tool_calls) {
      const fn      = tc.function;
      const toolArgs = typeof fn.arguments === "string"
        ? JSON.parse(fn.arguments)
        : fn.arguments;

      log("TOOL", `${fn.name}(${JSON.stringify(toolArgs).slice(0, 100)})`);

      // Double-check permission saat eksekusi (defense in depth)
      if (!isToolAllowed(fn.name, roleConfig.allowedTools)) {
        log("GUARD", `Tool ${fn.name} ditolak untuk role ${roleConfig._role || 'unknown'}`);
        allMessages.push({
          role:    "tool",
          content: `❌ Akses ditolak: tool '${fn.name}' tidak tersedia untuk role Anda.`,
        });
        continue;
      }

      // Inject allowed_folders untuk tool dokumen berdasarkan role
      if (["cari_dokumen", "list_dokumen"].includes(fn.name) && roleConfig.allowedDocs) {
        toolArgs.allowed_folders = roleConfig.allowedDocs;
        log("AUTH", `${fn.name}: filter folder → [${roleConfig.allowedDocs.join(", ")}]`);
      }

      let toolResult;
      try {
        toolResult = await mcp.callTool(fn.name, toolArgs);
      } catch (err) {
        toolResult = `Error memanggil tool ${fn.name}: ${err.message}`;
        log("ERROR", `Tool ${fn.name}: ${err.message}`);
      }

      // Potong tool result jika terlalu panjang — cegah context overflow
      const MAX_TOOL_CHARS = parseInt(process.env.MAX_TOOL_CHARS || "2000");
      const trimmedResult  = toolResult.length > MAX_TOOL_CHARS
        ? toolResult.slice(0, MAX_TOOL_CHARS) + `\n... (output dipotong, total ${toolResult.length} chars)`
        : toolResult;

      allMessages.push({
        role:    "tool",
        content: trimmedResult,
      });
    }
  }

  // Jika sudah 5 iterasi tapi belum selesai
  return {
    reply:    "Maaf, proses tool call terlalu dalam. Coba pertanyaan yang lebih spesifik.",
    messages: allMessages,
  };
}

// ============================================================
//  EXPRESS APP
// ============================================================
const app = express();
app.use(express.json());

// CORS — izinkan dari Laravel/PWA
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── POST /api/chat ───────────────────────────────────────────
/**
 * Request body:
 * {
 *   "session_id": "user-123",   // wajib — ID unik per user/conversation
 *   "message": "tampilkan data projects"
 * }
 *
 * Response:
 * {
 *   "session_id": "user-123",
 *   "reply": "...",
 *   "history_count": 4
 * }
 */
app.post("/api/chat", async (req, res) => {
  const { session_id, message, role = DEFAULT_ROLE } = req.body;

  // Validasi input
  if (!session_id || typeof session_id !== "string") {
    return res.status(400).json({ error: "session_id wajib diisi (string)" });
  }
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message wajib diisi dan tidak boleh kosong" });
  }

  const config = getRoleConfig(role);
  log("CHAT", `[${session_id}][${role}] ${message.slice(0, 80)}`);

  try {
    const session = sessions.getOrCreate(session_id);

    const historySnapshot = [...session.history];
    sessions.addMessage(session_id, "user", message.trim());

    const ollamaMessages = [
      { role: "system", content: config.systemPrompt },
      ...historySnapshot,
      { role: "user", content: message.trim() },
    ];

    // Kirim ke Ollama + eksekusi tool via MCP
    const { reply } = await chatWithTools(ollamaMessages, { ...config, _role: role });

    // Simpan balasan AI ke history
    sessions.addMessage(session_id, "assistant", reply);

    log("CHAT", `[${session_id}] → ${reply.slice(0, 80)}`);

    return res.json({
      session_id,
      role,
      reply,
      history_count: session.history.length,
    });

  } catch (err) {
    log("ERROR", `/api/chat: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/sessions ────────────────────────────────────────
app.get("/api/sessions", (req, res) => {
  res.json({ sessions: sessions.list() });
});

// ── DELETE /api/sessions/:id ─────────────────────────────────
app.delete("/api/sessions/:id", (req, res) => {
  const existed = sessions.delete(req.params.id);
  if (!existed) return res.status(404).json({ error: "Session tidak ditemukan" });
  log("SESSION", `Dihapus: ${req.params.id}`);
  res.json({ message: "Session berhasil dihapus" });
});

// ── GET /api/history/:id ─────────────────────────────────────
app.get("/api/history/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session tidak ditemukan" });
  res.json({
    session_id: req.params.id,
    history:    session.history,
  });
});

// ── GET /api/health ──────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status:        "ok",
    mcp_connected: mcp.connected,
    mcp_tools:     mcp.tools.map(t => t.name),
    ollama_url:    OLLAMA_URL,
    ollama_model:  OLLAMA_MODEL,
    roles:         Object.keys(ROLE_CONFIG).map(r => ({
      role:          r,
      allowedTools:  ROLE_CONFIG[r].allowedTools?.length ?? "all",
      allowedTables: ROLE_CONFIG[r].allowedTables?.length ?? "all",
    })),
    default_role:  DEFAULT_ROLE,
    sessions:      sessions.sessions.size,
    uptime_sec:    Math.floor(process.uptime()),
  });
});

// ── 404 fallback ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} tidak ditemukan` });
});

// ============================================================
//  STARTUP
// ============================================================
async function start() {
  try {
    // Hubungkan ke MCP server dulu sebelum terima request
    await mcp.connect();

    app.listen(PORT, () => {
      log("READY", `Gateway berjalan di http://localhost:${PORT}`);
      log("READY", `Endpoints:`);
      log("READY", `  POST   http://localhost:${PORT}/api/chat`);
      log("READY", `  GET    http://localhost:${PORT}/api/sessions`);
      log("READY", `  GET    http://localhost:${PORT}/api/history/:id`);
      log("READY", `  DELETE http://localhost:${PORT}/api/sessions/:id`);
      log("READY", `  GET    http://localhost:${PORT}/api/health`);
    });
  } catch (err) {
    console.error(`[ERROR] Gagal start gateway: ${err.message}`);
    process.exit(1);
  }
}

start();
