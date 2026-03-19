/**
 * gateway-groq.mjs — AI Chat Gateway v1.0.0 (Groq Edition)
 *
 * HTTP wrapper untuk MCP server + Groq Cloud API.
 * Jalankan: node gateway-groq.mjs
 *
 * Endpoints:
 *   POST /api/chat          — kirim pesan, dapat balasan AI
 *   GET  /api/sessions      — list semua session aktif
 *   DELETE /api/sessions/:id — hapus session (reset history)
 *   GET  /api/health        — cek status server
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

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL   = process.env.GROQ_MODEL   || "llama-3.1-8b-instant";
const GROQ_URL     = "https://api.groq.com/openai/v1/chat/completions";
const PORT         = parseInt(process.env.GATEWAY_PORT || "3000");
const MCP_SCRIPT   = join(__dirname, "index.mjs");

// Batas history per session (hemat context window)
const MAX_HISTORY  = parseInt(process.env.MAX_HISTORY || "20");
// Groq tidak pakai num_ctx — dikelola otomatis oleh Groq

// Timeout session idle sebelum dihapus (default 30 menit)
const SESSION_TTL  = parseInt(process.env.SESSION_TTL || "1800000");

function log(tag, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}][${tag}] ${msg}`);
}

// ============================================================
//  SYSTEM PROMPT
// ============================================================
const SYSTEM_PROMPT = `Kamu adalah AI database analyst untuk sistem konstruksi. Jawab dalam Bahasa Indonesia.

ATURAN KONTEKS PERCAKAPAN:
- Kamu memiliki akses ke history percakapan sebelumnya
- Jika user menggunakan kata ganti seperti "datanya", "itu", "tabel tadi", "yang tadi" — gunakan konteks dari history untuk menentukan maksudnya
- JANGAN minta konfirmasi jika konteks sudah jelas dari history
- Contoh: user tanya struktur "projects" lalu bilang "tampilkan datanya" → langsung query tabel projects

ATURAN TOOL:

[TANYA_DATABASE]
- Gunakan jika user meminta data, laporan, atau angka dari database
- LANGSUNG panggil tanya_database — JANGAN panggil daftar_tabel dulu
- Satu pertanyaan = satu tool call
- Tampilkan data RAW dari hasil tool, JANGAN diringkas kecuali diminta
- Jika nama tabel tidak disebut tapi jelas dari konteks history → gunakan tabel tersebut

[LIHAT_STRUKTUR_TABEL]
- Gunakan hanya jika user tanya struktur atau kolom tabel tertentu

[DAFTAR_TABEL]
- Gunakan HANYA jika user tanya "tabel apa saja yang ada"
- JANGAN panggil sebelum atau bersamaan dengan tanya_database

[BACA_CATATAN]
- Gunakan jika user tanya tentang catatan atau memory tersimpan
- Jawab HANYA dari isi catatan — DILARANG mengarang
- Jika tidak ada di catatan → katakan "Tidak ada di catatan"

[TULIS_CATATAN]
- HANYA jika user SECARA EKSPLISIT minta simpan catatan
- DILARANG dipanggil otomatis

[DOKUMEN PERUSAHAAN — list_dokumen, cari_dokumen, baca_dokumen]
- Gunakan untuk pertanyaan tentang: peraturan, kebijakan, SOP, prosedur, hak, kewajiban karyawan
- SETIAP pertanyaan tentang peraturan WAJIB panggil cari_dokumen — meskipun topik sudah dibahas sebelumnya
- Alur: cari_dokumen(keyword) → jika perlu detail → baca_dokumen(path)
- Contoh trigger: "cuti", "lembur", "reimburse", "jam kerja", "keterlambatan", "gaji", "absen", "SP"
- JANGAN gunakan tanya_database untuk pertanyaan peraturan — gunakan cari_dokumen
- File .md adalah SATU-SATUNYA sumber kebenaran — DILARANG jawab dari pengetahuan umum atau UU

ATURAN SETELAH TOOL RETURN DATA:
- Setelah tanya_database return hasil, cukup tulis: "Ditemukan X baris dari tabel Y." lalu tampilkan MAKSIMAL 3 baris pertama sebagai contoh
- JANGAN tulis ulang seluruh JSON — terlalu panjang dan tidak perlu
- Jika user ingin lihat semua data, sarankan filter lebih spesifik
- Untuk list_dokumen dan cari_dokumen, rangkum hasil secara singkat

LARANGAN KERAS:
- DILARANG jawab pertanyaan database dari ingatan sendiri tanpa tool
- DILARANG jawab pertanyaan peraturan perusahaan tanpa memanggil cari_dokumen terlebih dahulu
- DILARANG menggunakan pengetahuan umum tentang UU Ketenagakerjaan atau aturan luar sebagai jawaban
- Jika cari_dokumen tidak menemukan hasil → katakan "Tidak ada informasi di dokumen perusahaan"
- DILARANG merangkum data kecuali diminta
- DILARANG panggil tool yang tidak relevan
- DILARANG minta konfirmasi tabel jika sudah jelas dari percakapan sebelumnya
- DILARANG menulis ulang seluruh JSON hasil query — cukup konfirmasi jumlah baris`;

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

  /** Convert MCP tools ke format Ollama tools */
  getOllamaTools() {
    return this.tools.map((t) => ({
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
//  GROQ CHAT — dengan tool call loop (OpenAI-compatible format)
// ============================================================
async function chatWithTools(messages) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY belum diset di .env");

  const groqTools   = mcp.getOllamaTools(); // format sama dengan OpenAI
  const allMessages = [...messages];

  // Loop maksimal 5 iterasi untuk cegah infinite tool call
  for (let iter = 0; iter < 5; iter++) {
    log("DEBUG", `Iter ${iter+1} — ${allMessages.length} messages (last: ${allMessages[allMessages.length-1]?.role})`);

    // Timeout 30 detik — Groq sangat cepat, tidak perlu 120 detik
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 30_000);

    let res;
    try {
      res = await fetch(GROQ_URL, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model:               GROQ_MODEL,
          messages:            allMessages,
          tools:               groqTools,
          tool_choice:         "auto",
          temperature:         0,
          max_completion_tokens: 1024,
          stream:              false,
        }),
      });
    } catch (err) {
      if (err.name === "AbortError") throw new Error("Groq timeout (>30 detik).");
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const errText = await res.text();
      // Handle rate limit Groq
      if (res.status === 429) {
        throw new Error("Groq rate limit tercapai. Coba lagi dalam beberapa detik.");
      }
      throw new Error(`Groq error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    // Groq pakai format OpenAI: data.choices[0].message
    const msg  = data.choices?.[0]?.message;
    if (!msg) throw new Error("Groq response tidak valid");

    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const hasContent   = msg.content && msg.content.trim().length > 0;

    if (!hasToolCalls && !hasContent) {
      log("WARN", `Iter ${iter+1}: model return kosong`);
      allMessages.push({
        role:    "user",
        content: "Tolong jawab pertanyaan saya. Gunakan tool yang tersedia jika diperlukan.",
      });
      continue;
    }

    // Tidak ada tool call → selesai
    if (!hasToolCalls) {
      return { reply: msg.content, messages: allMessages };
    }

    // Ada tool call → eksekusi via MCP lalu lanjut loop
    allMessages.push(msg);

    // Push assistant message dulu (wajib sebelum tool result di OpenAI format)
    allMessages.push(msg);

    for (const tc of msg.tool_calls) {
      const fn       = tc.function;
      const toolArgs = typeof fn.arguments === "string"
        ? JSON.parse(fn.arguments)
        : fn.arguments;

      log("TOOL", `${fn.name}(${JSON.stringify(toolArgs).slice(0, 100)})`);

      let toolResult;
      try {
        toolResult = await mcp.callTool(fn.name, toolArgs);
      } catch (err) {
        toolResult = `Error memanggil tool ${fn.name}: ${err.message}`;
        log("ERROR", `Tool ${fn.name}: ${err.message}`);
      }

      // Potong tool result — cegah context overflow
      const MAX_TOOL_CHARS = parseInt(process.env.MAX_TOOL_CHARS || "2000");
      const trimmedResult  = toolResult.length > MAX_TOOL_CHARS
        ? toolResult.slice(0, MAX_TOOL_CHARS) + `\n... (output dipotong)`
        : toolResult;

      // Groq wajib pakai tool_call_id di response
      allMessages.push({
        role:         "tool",
        tool_call_id: tc.id,
        content:      trimmedResult,
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
  const { session_id, message } = req.body;

  // Validasi input
  if (!session_id || typeof session_id !== "string") {
    return res.status(400).json({ error: "session_id wajib diisi (string)" });
  }
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message wajib diisi dan tidak boleh kosong" });
  }

  log("CHAT", `[${session_id}] ${message.slice(0, 80)}`);

  try {
    const session = sessions.getOrCreate(session_id);

    // Susun messages untuk Ollama DULU (snapshot history saat ini)
    // PENTING: addMessage dilakukan SETELAH snapshot agar pesan user
    // masuk dalam urutan yang benar ke Ollama
    const historySnapshot = [...session.history];
    sessions.addMessage(session_id, "user", message.trim());

    const ollamaMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...historySnapshot,
      { role: "user", content: message.trim() },
    ];

    // Kirim ke Ollama + eksekusi tool via MCP
    const { reply } = await chatWithTools(ollamaMessages);

    // Simpan balasan AI ke history
    sessions.addMessage(session_id, "assistant", reply);

    log("CHAT", `[${session_id}] → ${reply.slice(0, 80)}`);

    return res.json({
      session_id,
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
    status:       "ok",
    mcp_connected: mcp.connected,
    mcp_tools:    mcp.tools.map(t => t.name),
    provider:     "groq",
    groq_model:   GROQ_MODEL,
    api_key_set:  !!GROQ_API_KEY,
    sessions:     sessions.sessions.size,
    uptime_sec:   Math.floor(process.uptime()),
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
      if (!GROQ_API_KEY) log("WARN", "GROQ_API_KEY belum diset! Tambahkan ke .env");
      log("READY", `Gateway (Groq) berjalan di http://localhost:${PORT}`);
      log("READY", `Model: ${GROQ_MODEL}`);
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
