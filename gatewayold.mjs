/**
 * gateway.mjs — AI Chat Gateway v2.1.0
 * Perubahan dari v2.0:
 * - Streaming fix: JSON.parse try-catch agar tidak crash
 * - SSE parser yang benar (slice 6 chars, bukan replace)
 * - executeTool() helper — logic tool reuse antara chat & stream
 * - CORS, session, role config tetap sama
 */

import express                  from "express";
import { readFile }             from "fs/promises";
import { existsSync }           from "fs";
import { fileURLToPath }        from "url";
import { dirname, join }        from "path";
import { Client }               from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

const OLLAMA_URL     = process.env.OLLAMA_URL     || "http://127.0.0.1:11434";
const OLLAMA_MODEL   = process.env.OLLAMA_MODEL   || "qwen-analyst";
const PORT           = parseInt(process.env.GATEWAY_PORT  || "3000");
const MCP_SCRIPT     = join(__dirname, "index.mjs");
const MAX_HISTORY    = parseInt(process.env.MAX_HISTORY   || "20");
const NUM_CTX        = parseInt(process.env.NUM_CTX       || "4096");
const SESSION_TTL    = parseInt(process.env.SESSION_TTL   || "1800000");
const MAX_TOOL_CHARS = parseInt(process.env.MAX_TOOL_CHARS || "3000");

function log(tag, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}][${tag}] ${msg}`);
}

// ── ROLE CONFIG ──────────────────────────────────────────────
const ATURAN_UMUM = `
BAHASA: Selalu jawab dalam Bahasa Indonesia.

[DOKUMEN - WAJIB DIPATUHI]
- Glosarium/Istilah: LANGSUNG panggil cari_dokumen.
- pp/pp.md → Peraturan Perusahaan YOGYA Group (pasal-pasal, hak karyawan, dll)
- Kebijakan: cari_dokumen lalu baca_dokumen.
- Sumber Tunggal: Hanya file .md, dilarang mengarang.
- DILARANG MUTLAK menambah, mengurangi, atau mengubah isi dokumen

ATURAN TOOL:
[TANYA_DATABASE] WAJIB untuk setiap pertanyaan data. LANGSUNG panggil tanpa daftar_tabel.
[LIHAT_STRUKTUR_TABEL] Jika user tanya struktur/kolom tabel.
[DAFTAR_TABEL] HANYA jika user tanya "tabel apa saja yang ada".
[BACA_CATATAN] Untuk pertanyaan tentang catatan tersimpan.
[TULIS_CATATAN] HANYA jika user eksplisit minta simpan catatan.
[cari_dokumen, baca_dokumen, list_dokumen] WAJIB untuk pertanyaan peraturan/kebijakan/istilah.

LARANGAN MUTLAK:
- DILARANG jawab dari ingatan sendiri tanpa tool
- DILARANG mengarang data, nama, atau angka
- DILARANG skip tool call untuk pertanyaan lanjutan`;

const READ_ONLY_TOOLS = ["tanya_database","lihat_struktur_tabel","daftar_tabel","baca_catatan","list_dokumen","cari_dokumen","baca_dokumen"];
const WRITE_TOOLS     = ["tulis_catatan","perbarui_catatan","hapus_semua_catatan","refresh_cache"];
const ALL_TOOLS       = [...READ_ONLY_TOOLS, ...WRITE_TOOLS];

const ROLE_CONFIG = {
  cs: {
    systemPrompt: `Kamu adalah customer service AI yang ramah dan profesional.\nBantu customer dengan pertanyaan seputar produk, layanan, status proyek, dan kebijakan umum.\n${ATURAN_UMUM}\nBATASAN:\n- HANYA tabel: projects, vendors\n- Untuk istilah/deskripsi → cari_dokumen ke glosarium\n- Di luar kapasitas → "Hubungi tim CS kami"`,
    allowedTables: ["projects","vendors"],
    allowedDocs:   ["faq","policy","glosarium"],
    allowedTools:  READ_ONLY_TOOLS,
    maxHistory:    10,
    toolRestrictionMsg: "Tidak bisa menulis/mengubah/menghapus catatan.",
  },
  spv: {
    systemPrompt: `Kamu adalah AI analyst untuk level Supervisor.\nAkses semua data dan dokumen.\n${ATURAN_UMUM}`,
    allowedTables: null, allowedDocs: null, allowedTools: READ_ONLY_TOOLS, maxHistory: 20,
    toolRestrictionMsg: "Tidak bisa menulis/mengubah/menghapus catatan.",
  },
  finance: {
    systemPrompt: `Kamu adalah AI analyst untuk tim Finance.\nFokus data keuangan, budget, realisasi.\n${ATURAN_UMUM}`,
    allowedTables: null, allowedDocs: null, allowedTools: READ_ONLY_TOOLS, maxHistory: 20,
    toolRestrictionMsg: "Tidak bisa menulis/mengubah/menghapus catatan.",
  },
  director: {
    systemPrompt: `Kamu adalah AI analyst untuk Direktur.\nAnalisis ringkas dan insight strategis.\n${ATURAN_UMUM}`,
    allowedTables: null, allowedDocs: null, allowedTools: READ_ONLY_TOOLS, maxHistory: 20,
    toolRestrictionMsg: "Tidak bisa menulis/mengubah/menghapus catatan.",
  },
  admin: {
    systemPrompt: `Kamu adalah AI analyst untuk Admin sistem.\nAkses penuh termasuk kelola knowledge base.\n${ATURAN_UMUM}`,
    allowedTables: null, allowedDocs: null, allowedTools: ALL_TOOLS, maxHistory: 20,
  },
};

const DEFAULT_ROLE = "cs";

function getRoleConfig(role) {
  const config = ROLE_CONFIG[role] || ROLE_CONFIG[DEFAULT_ROLE];
  if (config.toolRestrictionMsg) {
    return { ...config, systemPrompt: config.systemPrompt + `\n\nBATASAN ROLE: ${config.toolRestrictionMsg}` };
  }
  return config;
}

function isToolAllowed(toolName, allowedTools) {
  if (!allowedTools) return true;
  return allowedTools.includes(toolName);
}

// ── SESSION MANAGER ──────────────────────────────────────────
class SessionManager {
  constructor() {
    this.sessions = new Map();
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }
  get(id) { const s = this.sessions.get(id); if (s) s.lastActive = Date.now(); return s; }
  getOrCreate(id) {
    if (!this.sessions.has(id)) {
      this.sessions.set(id, { history: [], lastActive: Date.now(), createdAt: Date.now() });
      log("SESSION", `Baru: ${id}`);
    }
    return this.get(id);
  }
  addMessage(id, role, content) {
    const s = this.getOrCreate(id);
    s.history.push({ role, content: String(content) });
    if (s.history.length > MAX_HISTORY) { s.history.splice(0, 2); }
  }
  delete(id) { const ex = this.sessions.has(id); this.sessions.delete(id); return ex; }
  list() {
    const now = Date.now();
    return [...this.sessions.entries()].map(([id, s]) => ({
      sessionId: id, messageCount: s.history.length,
      idleMinutes: Math.floor((now - s.lastActive) / 60000),
      createdAt: new Date(s.createdAt).toISOString(),
    }));
  }
  cleanup() {
    const now = Date.now(); let removed = 0;
    for (const [id, s] of this.sessions) {
      if (now - s.lastActive > SESSION_TTL) { this.sessions.delete(id); removed++; }
    }
    if (removed > 0) log("SESSION", `Cleanup: ${removed} dihapus`);
  }
}
const sessions = new SessionManager();

// ── MCP CLIENT ───────────────────────────────────────────────
class McpClientManager {
  constructor() { this.client = null; this.tools = []; this.connected = false; }
  async connect() {
    if (this.connected) return;
    log("MCP", `Menghubungkan ke ${MCP_SCRIPT}...`);
    const transport = new StdioClientTransport({ command: "node", args: [MCP_SCRIPT] });
    this.client = new Client({ name: "ai-gateway", version: "2.1.0" }, { capabilities: {} });
    await this.client.connect(transport);
    const result = await this.client.listTools();
    this.tools = result.tools; this.connected = true;
    log("MCP", `Terhubung. ${this.tools.length} tools: ${this.tools.map(t => t.name).join(", ")}`);
  }
  async callTool(name, args) {
    if (!this.connected) throw new Error("MCP belum terhubung");
    const result = await this.client.callTool({ name, arguments: args });
    return result.content?.[0]?.text ?? "";
  }
  getOllamaTools(allowedTools = null) {
    const tools = allowedTools ? this.tools.filter(t => allowedTools.includes(t.name)) : this.tools;
    return tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  }
}
const mcp = new McpClientManager();

// ── EXECUTE TOOL (shared helper) ─────────────────────────────
async function executeTool(tc, roleConfig) {
  const fn       = tc.function;
  let   toolArgs = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments;

  log("TOOL", `${fn.name}(${JSON.stringify(toolArgs).slice(0, 100)})`);

  if (!isToolAllowed(fn.name, roleConfig.allowedTools)) {
    log("GUARD", `${fn.name} ditolak untuk ${roleConfig._role}`);
    return `❌ Akses ditolak: tool '${fn.name}' tidak tersedia untuk role Anda.`;
  }

  if (["cari_dokumen","list_dokumen"].includes(fn.name) && roleConfig.allowedDocs) {
    toolArgs.allowed_folders = roleConfig.allowedDocs;
  }

  if (fn.name === "tanya_database" && roleConfig.allowedTables) {
    const q = (toolArgs.pertanyaan || "").toLowerCase();
    if (!roleConfig.allowedTables.some(t => q.includes(t))) {
      return `❌ Akses Ditolak: hanya bisa akses tabel: ${roleConfig.allowedTables.join(", ")}`;
    }
  }

  let result;
  try {
    result = await mcp.callTool(fn.name, toolArgs);
  } catch (err) {
    result = `Error tool ${fn.name}: ${err.message}`;
  }

  if (result.length > MAX_TOOL_CHARS) {
    result = result.slice(0, MAX_TOOL_CHARS) + `\n... (dipotong, total ${result.length} chars)`;
  }
  return result;
}

// ── CHAT NON-STREAMING ───────────────────────────────────────
async function chatWithTools(messages, roleConfig = {}) {
  const ollamaTools = mcp.getOllamaTools(roleConfig.allowedTools || null);
  log("AUTH", `Role ${roleConfig._role || "?"} — ${ollamaTools.length} tools`);
  const allMessages = [...messages];

  for (let iter = 0; iter < 5; iter++) {
    log("DEBUG", `Iter ${iter + 1} — ${allMessages.length} msgs`);
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 120_000);

    let res;
    try {
      res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: OLLAMA_MODEL, messages: allMessages, tools: ollamaTools, stream: false,
          options: { temperature: 0, num_ctx: NUM_CTX, num_predict: 1024, repeat_penalty: 1.1, stop: ["<|file_separator|>","user:"] },
        }),
      });
    } catch (err) {
      if (err.name === "AbortError") throw new Error("Timeout >120 detik. Coba pertanyaan lebih spesifik.");
      throw err;
    } finally { clearTimeout(timeout); }

    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);

    const data = await res.json();
    const msg  = data.message;
    const hasTools   = msg.tool_calls?.length > 0;
    const hasContent = msg.content?.trim().length > 0;

    if (!hasTools && !hasContent) {
      allMessages.push({ role: "user", content: "Tolong jawab. Gunakan tool jika perlu." });
      continue;
    }

    if (!hasTools && hasContent && iter === 0) {
      const lastUser  = [...allMessages].reverse().find(m => m.role === "user")?.content || "";
      const isData    = /\b(siapa|berapa|tampilkan|lihat|daftar|cari|data|total|list|ada|terdaftar)\b/i.test(lastUser);
      const hasDbTool = ollamaTools.some(t => t.function.name === "tanya_database");
      if (isData && hasDbTool) {
        allMessages.push({ role: "assistant", content: msg.content });
        allMessages.push({ role: "user", content: "Panggil tool tanya_database sekarang. Jangan jawab dari ingatan." });
        continue;
      }
    }

    if (!hasTools) return { reply: msg.content, messages: allMessages };

    allMessages.push(msg);
    for (const tc of msg.tool_calls) {
      const result = await executeTool(tc, roleConfig);
      allMessages.push({ role: "tool", content: result, tool_call_id: tc.id });
    }
  }

  return { reply: "Batas iterasi tercapai. Coba pertanyaan lebih spesifik.", messages: allMessages };
}

// ── CHAT STREAMING (SSE) ─────────────────────────────────────
async function chatWithToolsStream(messages, roleConfig, res, sessionId) {
  const ollamaTools = mcp.getOllamaTools(roleConfig.allowedTools || null);
  let   allMessages = [...messages];
  let   toolCallCount = 0;        // ← tambah counter
  const MAX_TOOL_CALLS = 3;       // ← maksimal 3 tool call per turn

  for (let iter = 0; iter < 5; iter++) {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 120_000);

    // Kalau sudah melebihi batas tool call, paksa stop dengan kosongkan tools
    const activeTools = toolCallCount >= MAX_TOOL_CALLS ? [] : ollamaTools;

    let ollamaRes;
    try {
      ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: OLLAMA_MODEL, messages: allMessages,
          tools: activeTools,  // ← pakai activeTools bukan ollamaTools
          stream: true,
          options: { temperature: 0, num_ctx: NUM_CTX, num_predict: 1024, repeat_penalty: 1.1 },
        }),
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === "AbortError") { res.write(`data: ⏱️ Timeout.\n\n`); return; }
      throw err;
    } finally { clearTimeout(timeout); }

    let fullContent = "";
    let toolCalls   = [];
    const decoder   = new TextDecoder();

    for await (const chunk of ollamaRes.body) {
      const text  = decoder.decode(chunk, { stream: true });
      const lines = text.split("\n");

      for (const line of lines) {
        if (!line.trim()) continue;
        let json;
        try { json = JSON.parse(line); } catch { continue; }
        if (json.done) break;
        const delta = json.message;
        if (!delta) continue;
        if (delta.tool_calls?.length) toolCalls = delta.tool_calls;
        if (delta.content) {
          fullContent += delta.content;
          res.write(`data: ${delta.content}\n\n`);
        }
      }
    }

    if (toolCalls.length === 0) {
      sessions.addMessage(sessionId, "assistant", fullContent);
      return;
    }

    // Tambah ke counter
    toolCallCount += toolCalls.length;
    log("TOOL-COUNT", `${toolCallCount}/${MAX_TOOL_CALLS} tool calls dipakai`);

    allMessages.push({ role: "assistant", content: fullContent, tool_calls: toolCalls });
    res.write(`data: \n\ndata: *— memproses ${toolCalls[0]?.function?.name || "tool"}...*\n\n`);

    for (const tc of toolCalls) {
      let result = await executeTool(tc, roleConfig);

      // Tambah flag stop kalau hasil kosong
      if (result.includes('0 baris ditemukan')) {
        result += '\n[Data tidak ditemukan. Sampaikan ke user, jangan query ulang.]';
      }

      allMessages.push({ role: "tool", content: result, tool_call_id: tc.id });
    }

    // Kalau sudah max tool calls, inject instruksi stop
    if (toolCallCount >= MAX_TOOL_CALLS) {
      log("TOOL-COUNT", "Batas tool call tercapai — force stop");
      allMessages.push({
        role: "user",
        content: "Berikan jawaban final berdasarkan data yang sudah ada. Jangan panggil tool lagi.",
      });
    }
  }

  res.write(`data: Batas iterasi tercapai.\n\n`);
}

// ── EXPRESS ──────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// POST /api/chat
app.post("/api/chat", async (req, res) => {
  const { session_id, message, role = DEFAULT_ROLE } = req.body;
  if (!session_id || typeof session_id !== "string") return res.status(400).json({ error: "session_id wajib" });
  if (!message || !message.trim()) return res.status(400).json({ error: "message wajib" });

  const config = getRoleConfig(role);
  log("CHAT", `[${session_id}][${role}] ${message.slice(0, 80)}`);

  try {
    const session         = sessions.getOrCreate(session_id);
    const historySnapshot = [...session.history];
    sessions.addMessage(session_id, "user", message.trim());

    const ollamaMessages = [
      { role: "system", content: config.systemPrompt },
      ...historySnapshot,
      { role: "user", content: message.trim() },
    ];

    const { reply } = await chatWithTools(ollamaMessages, { ...config, _role: role });
    sessions.addMessage(session_id, "assistant", reply);
    log("CHAT", `[${session_id}] → ${reply.slice(0, 80)}`);

    return res.json({ session_id, role, reply, history_count: session.history.length });
  } catch (err) {
    log("ERROR", `/api/chat: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/chat/stream
app.post("/api/chat/stream", async (req, res) => {
  const { session_id, message, role = DEFAULT_ROLE } = req.body;
  if (!session_id || !message?.trim()) return res.status(400).json({ error: "session_id dan message wajib" });

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");

  log("STREAM", `[${session_id}][${role}] ${message.slice(0, 80)}`);

  try {
    const session         = sessions.getOrCreate(session_id);
    const historySnapshot = [...session.history];
    sessions.addMessage(session_id, "user", message.trim());

    const config         = getRoleConfig(role);
    const ollamaMessages = [
      { role: "system", content: config.systemPrompt },
      ...historySnapshot,
      { role: "user", content: message.trim() },
    ];

    await chatWithToolsStream(ollamaMessages, { ...config, _role: role }, res, session_id);
  } catch (err) {
    log("ERROR", `/api/chat/stream: ${err.message}`);
    res.write(`data: ❌ Error: ${err.message}\n\n`);
  } finally {
    res.end();
  }
});

// GET /api/sessions
app.get("/api/sessions", (req, res) => res.json({ sessions: sessions.list() }));

// GET /api/history/:id
app.get("/api/history/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Session tidak ditemukan" });
  res.json({ session_id: req.params.id, history: s.history });
});

// DELETE /api/sessions/:id
app.delete("/api/sessions/:id", (req, res) => {
  const existed = sessions.delete(req.params.id);
  if (!existed) return res.status(404).json({ error: "Session tidak ditemukan" });
  log("SESSION", `Dihapus: ${req.params.id}`);
  res.json({ message: "Session berhasil dihapus" });
});

// GET /api/health
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok", mcp_connected: mcp.connected,
    mcp_tools: mcp.tools.map(t => t.name),
    ollama_url: OLLAMA_URL, ollama_model: OLLAMA_MODEL,
    roles: Object.keys(ROLE_CONFIG).map(r => ({
      role: r,
      allowedTools:  ROLE_CONFIG[r].allowedTools?.length ?? "all",
      allowedTables: ROLE_CONFIG[r].allowedTables?.length ?? "all",
    })),
    default_role: DEFAULT_ROLE,
    sessions: sessions.sessions.size,
    uptime_sec: Math.floor(process.uptime()),
  });
});

app.use((req, res) => res.status(404).json({ error: `${req.method} ${req.path} tidak ditemukan` }));

// ── STARTUP ──────────────────────────────────────────────────
async function start() {
  try {
    await mcp.connect();
    app.listen(PORT, () => {
      log("READY", `Gateway v2.1.0 → http://localhost:${PORT}`);
      log("READY", `Model: ${OLLAMA_MODEL}`);
    });
  } catch (err) {
    console.error(`[ERROR] Gagal start: ${err.message}`);
    process.exit(1);
  }
}

start();
