/**
 * MCP (Model Context Protocol) adapter core.
 *
 * Deliberately pi-free (same idiom as search_hops.ts) so it bundles standalone
 * for unit tests. Supports the two transports that matter here:
 *
 *  - "stdio": spawn a local server process (chrome-devtools-mcp, filesystem, ...)
 *  - "http":  streamable HTTP against a remote server (host + port [+ path])
 *
 * The registry is controlled by the agent itself: `mcp_connect` discovers a
 * server's tools and registers each one as `mcp_<server>_<tool>`; the user's
 * global killswitch is `mcpkill.json` (flipped by the /mcp-toggle command).
 *
 * Security notes baked into the design:
 *  - MCP tool output is external content: text is capped and callers are told
 *    it is untrusted. Do not paste raw MCP output into the system prompt.
 *  - Connections only ever happen because the user asked for one; the
 *    mcp_connect description must say so.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types & config persistence
// ---------------------------------------------------------------------------

export interface McpStdioConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpConfig {
  transport: "http";
  host: string;
  port: number;
  path?: string;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: any;
}

export interface McpToolMeta {
  tool: string; // original name on the server
  mcpName: string; // registered name: mcp_<server>_<tool>
  description?: string;
}

interface ServerEntry {
  config: McpServerConfig;
  client: McpClient;
  tools: McpToolMeta[];
  serverInfo?: any;
  connectedAt: string;
}

const PROTOCOL_VERSION = "2025-06-18";

export function mcpConfigFile(): string {
  return process.env.MYKYAGENT_MCP_FILE || join(homedir(), ".config", "mykyagent", "mcp.json");
}

function mcpKillFile(): string {
  return process.env.MYKYAGENT_MCPKILL_FILE || join(homedir(), ".config", "mykyagent", "mcpkill.json");
}

export function loadServerConfigs(): Record<string, McpServerConfig> {
  const file = mcpConfigFile();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    const servers = parsed?.servers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
    const out: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(servers as Record<string, any>)) {
      const valid = coerceConfig(cfg);
      if (valid) out[name] = valid;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveServerConfigs(servers: Record<string, McpServerConfig>): void {
  const file = mcpConfigFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ servers }, null, 2) + "\n", "utf-8");
}

/** Accept stored or model-supplied config shapes; return null when hopeless. */
export function coerceConfig(cfg: any): McpServerConfig | null {
  if (!cfg || typeof cfg !== "object") return null;
  const c = cfg as any;
  if (typeof c.command === "string" && c.command.trim()) {
    return {
      transport: "stdio",
      command: c.command.trim(),
      ...(Array.isArray(c.args) ? { args: c.args.map(String) } : {}),
      ...(c.env && typeof c.env === "object" ? { env: c.env } : {}),
    };
  }
  const port = Number(c.port);
  if (typeof c.host === "string" && c.host.trim() && Number.isInteger(port) && port > 0 && port < 65536) {
    return {
      transport: "http",
      host: c.host.trim(),
      port,
      ...(typeof c.path === "string" && c.path ? { path: c.path } : {}),
    };
  }
  return null;
}

export function mcpDisabled(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(mcpKillFile(), "utf-8"));
    return parsed?.disabled === true;
  } catch {
    return false;
  }
}

export function setMcpDisabled(disabled: boolean): void {
  const file = mcpKillFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ disabled }, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested offline)
// ---------------------------------------------------------------------------

export function sanitizeToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_")
    .slice(0, 24);
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp_${sanitizeToken(server)}_${sanitizeToken(tool)}`.slice(0, 64);
}

/** Extract JSON-RPC messages from an SSE body ("data:" lines). */
export function extractSseDataFrames(body: string): any[] {
  const out: any[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      // tolerate keep-alive comments / partial frames
    }
  }
  return out;
}

/** Map an MCP tools/call result to pi tool content, capping text size. */
export function capResultText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
  const cut = Buffer.from(text, "utf-8").subarray(0, maxBytes).toString("utf-8");
  return `${cut}\n[... MCP tool output truncated at ${maxBytes} bytes to protect context; ask the server for narrower output ...]`;
}

export function normalizeMcpResult(result: any, maxBytes: number): {
  content: any[];
  isError?: boolean;
} {
  if (!result || typeof result !== "object") {
    return { content: [{ type: "text", text: capResultText(String(result ?? ""), maxBytes) }] };
  }
  const blocks: any[] = Array.isArray(result.content) ? result.content : [];
  const content: any[] = [];
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") {
      content.push({ type: "text", text: capResultText(b.text, maxBytes) });
    } else if (b?.type === "image" && typeof b.data === "string") {
      content.push({ type: "image", data: b.data, mimeType: b.mimeType || "image/png" });
    } else if (b && typeof b === "object") {
      // Unknown block type: keep it, bounded. The model can still read JSON.
      content.push({ type: "text", text: capResultText(JSON.stringify(b), maxBytes) });
    }
  }
  if (content.length === 0) {
    const structured = result.structuredContent ?? result;
    content.push({ type: "text", text: capResultText(JSON.stringify(structured), maxBytes) });
  }
  return { content, ...(result.isError === true ? { isError: true } : {}) };
}

/** Ensure a server-provided inputSchema is a usable JSON object schema. */
export function validateInputSchema(schema: any): any {
  if (schema && typeof schema === "object" && schema.type === "object" && typeof schema.properties === "object") {
    return schema;
  }
  return { type: "object", properties: {}, additionalProperties: true };
}

function defaultServerName(config: McpServerConfig): string {
  if (config.transport === "stdio") return sanitizeToken(config.command.split("/").pop() || "stdio");
  return sanitizeToken(`${config.host}_${config.port}`);
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

export interface McpTransport {
  request(method: string, params?: any, timeoutMs?: number): Promise<any>;
  notify(method: string, params?: any): Promise<void>;
  close(): Promise<void>;
}

function jsonRpcRequest(id: number, method: string, params?: any) {
  const msg: any = { jsonrpc: "2.0", id, method };
  if (params !== undefined) msg.params = params;
  return msg;
}

/** Streamable HTTP transport (POST JSON-RPC; accept JSON or SSE responses). */
export class HttpMcpTransport implements McpTransport {
  private url: string;
  private nextId = 1;
  private sessionId: string | null = null;
  private headers: Record<string, string>;
  private closed = false;

  constructor(config: McpHttpConfig) {
    const path = config.path?.startsWith("/") ? config.path : `/${config.path || "mcp"}`;
    this.url = `http://${config.host}:${config.port}${path}`;
    this.headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
  }

  private async post(body: any, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: {
          ...this.headers,
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async request(method: string, params?: any, timeoutMs = 30_000): Promise<any> {
    if (this.closed) throw new Error("transport closed");
    const id = this.nextId++;
    const res = await this.post(jsonRpcRequest(id, method, params), timeoutMs);
    const ctype = res.headers.get("content-type") || "";
    const bodyText = await res.text();

    let messages: any[] = [];
    if (ctype.includes("text/event-stream")) {
      messages = extractSseDataFrames(bodyText);
    } else if (ctype.includes("json") || (!ctype && bodyText.trim().startsWith("{"))) {
      try {
        messages = [JSON.parse(bodyText)];
      } catch {
        /* fall through to error */
      }
    }

    if (res.status === 202 && messages.length === 0) {
      // Accepted-with-no-body: servers may answer notifications this way.
      return { jsonrpc: "2.0", id, result: {} };
    }

    const reply = messages.find((m) => m && m.id === id);
    if (!reply) {
      throw new Error(`HTTP ${res.status} from ${method}: no JSON-RPC reply (body: ${bodyText.slice(0, 200)})`);
    }
    if (reply.error) {
      throw new Error(`MCP error on ${method}: ${reply.error.code} ${reply.error.message}`);
    }
    return reply.result ?? {};
  }

  async notify(method: string, params?: any): Promise<void> {
    if (this.closed) return;
    try {
      const res = await this.post({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }, 10_000);
      // Drain body so the socket is reusable; ignore contents.
      await res.text().catch(() => {});
    } catch {
      // Notifications are best-effort; a failed one must not kill the session.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sessionId) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        await fetch(this.url, {
          method: "DELETE",
          headers: { "mcp-session-id": this.sessionId },
          signal: controller.signal,
        });
        clearTimeout(timer);
      } catch {
        /* best-effort */
      }
    }
  }
}

/** stdio transport: newline-delimited JSON-RPC over the child process. */
export class StdioMcpTransport implements McpTransport {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private closed = false;

  constructor(config: McpStdioConfig) {
    this.child = spawn(config.command, config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(config.env ?? {}) },
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    // stderr goes nowhere unless MYKYAGENT_MCP_LOG is set (server logs are not
    // agent-facing; dumping them into tool results burned context before).
    const logFile = process.env.MYKYAGENT_MCP_LOG;
    if (logFile) {
      mkdirSync(dirname(logFile), { recursive: true });
      this.child.stderr?.on("data", (chunk: Buffer) => {
        try {
          writeFileSync(logFile, chunk, { flag: "a" });
        } catch {}
      });
    }
    this.child.on("exit", (code) => this.onExit(`MCP server process exited (code ${code ?? "?"})`));
    this.child.on("error", (err) => this.onExit(`MCP server process failed to start: ${err.message}`));
  }

  private onExit(message: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "").trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // servers sometimes print banners; ignore non-JSON lines
      }
      if (msg && Number.isInteger(msg.id) && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`MCP error: ${msg.error.code} ${msg.error.message}`));
        else p.resolve(msg.result ?? {});
      }
      // notifications / replies to unknown ids: drop silently
    }
  }

  async request(method: string, params?: any, timeoutMs = 30_000): Promise<any> {
    if (this.closed) throw new Error("MCP server process is not running");
    if (!this.child.stdin?.writable) throw new Error("MCP server stdin is closed");
    const id = this.nextId++;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(JSON.stringify(jsonRpcRequest(id, method, params)) + "\n");
    });
  }

  async notify(method: string, params?: any): Promise<void> {
    if (this.closed || !this.child.stdin?.writable) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }) + "\n");
    } catch {}
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // Give the server a moment to shut down cleanly on stdin EOF, then SIGTERM.
    await new Promise<void>((resolve) => {
      const child = this.child;
      const done = () => resolve();
      child.once("exit", done);
      try {
        child.stdin?.end();
      } catch {}
      setTimeout(() => {
        if (!child.killed) {
          try {
            child.kill("SIGTERM");
          } catch {}
        }
        resolve();
      }, 1500).unref();
    });
    this.onExit("MCP server closed by client");
  }
}

// ---------------------------------------------------------------------------
// Client (one per server)
// ---------------------------------------------------------------------------

export class McpClient {
  transport: McpTransport;
  serverInfo: any = null;

  constructor(transport: McpTransport) {
    this.transport = transport;
  }

  async initialize(initTimeoutMs: number, clientName = "mykyagent"): Promise<void> {
    const result = await this.transport.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: clientName, version: "1.0.0" },
      },
      initTimeoutMs
    );
    this.serverInfo = result?.serverInfo ?? null;
    await this.transport.notify("notifications/initialized");
  }

  async listTools(timeoutMs: number): Promise<McpToolDef[]> {
    const result = await this.transport.request("tools/list", {}, timeoutMs);
    const tools = result?.tools;
    if (!Array.isArray(tools)) return [];
    return tools
      .filter((t: any) => t && typeof t.name === "string")
      .map((t: any) => ({
        name: t.name,
        ...(typeof t.description === "string" ? { description: t.description } : {}),
        ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
      }));
  }

  async callTool(name: string, args: any, timeoutMs: number): Promise<any> {
    return this.transport.request("tools/call", { name, arguments: args ?? {} }, timeoutMs);
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

// ---------------------------------------------------------------------------
// Registry (the piece index.ts talks to)
// ---------------------------------------------------------------------------

export interface McpRegistryHooks {
  register: (def: { name: string; label: string; description: string; parameters: any; execute: (id: string, args: any) => Promise<any> }) => void;
  unregister: (toolName: string) => void; // remove from ACTIVE toolset (pi has no unregisterTool)
}

export interface McpReconnectReport {
  connected: string[];
  failed: { name: string; error: string }[];
}

const MAX_TOOLS_PER_SERVER = 24;

function resultBytesCap(): number {
  const n = Number.parseInt(process.env.MYKYAGENT_MCP_RESULT_BYTES ?? "8000", 10);
  return Number.isFinite(n) && n > 1000 ? n : 8000;
}

function initTimeoutMs(): number {
  const n = Number.parseInt(process.env.MYKYAGENT_MCP_INIT_TIMEOUT ?? "45000", 10);
  return Number.isFinite(n) && n > 2000 ? n : 45000;
}

function callTimeoutMs(): number {
  const n = Number.parseInt(process.env.MYKYAGENT_MCP_CALL_TIMEOUT ?? "120000", 10);
  return Number.isFinite(n) && n > 2000 ? n : 120000;
}

export class McpRegistry {
  private servers = new Map<string, ServerEntry>();
  hooks: McpRegistryHooks | null = null;

  registeredToolNames(): string[] {
    const names: string[] = [];
    for (const [, entry] of this.servers) {
      for (const t of entry.tools) names.push(t.mcpName);
    }
    return names;
  }

  serverNames(): string[] {
    return Array.from(this.servers.keys());
  }

  isConnected(name: string): boolean {
    return this.servers.has(name);
  }

  async connect(nameArg: string | undefined, config: McpServerConfig): Promise<string> {
    if (mcpDisabled()) {
      throw new Error("The MCP adapter is DISABLED (/mcp-toggle). Ask the user to re-enable it; do not retry.");
    }
    const coerced = coerceConfig(config);
    if (!coerced) throw new Error("Invalid MCP server config: need {command,args} (stdio) or {host,port} (http).");
    const name = nameArg?.trim() ? sanitizeToken(nameArg.trim()) : defaultServerName(coerced);
    if (!name) throw new Error("Could not derive a server name; pass one explicitly.");

    // Reconnect replaces an existing session cleanly.
    if (this.servers.has(name)) await this.disconnect(name);

    const client = makeClient(coerced);
    try {
      await client.initialize(initTimeoutMs());
      const tools = await client.listTools(initTimeoutMs());
      const entry: ServerEntry = {
        config: coerced,
        client,
        tools: [],
        serverInfo: client.serverInfo,
        connectedAt: new Date().toISOString(),
      };
      this.servers.set(name, entry);

      const skipped: string[] = [];
      for (const tool of tools) {
        if (entry.tools.length >= MAX_TOOLS_PER_SERVER) {
          skipped.push(tool.name);
          continue;
        }
        const mcpName = mcpToolName(name, tool.name);
        entry.tools.push({ tool: tool.name, mcpName, description: tool.description });
        this.hooks?.register({
          name: mcpName,
          label: `MCP ${name}/${tool.name}`,
          description:
            tool.description ||
            `MCP tool "${tool.name}" from MCP server "${name}".`,
          parameters: validateInputSchema(tool.inputSchema),
          execute: async (_id: string, args: any) => {
            // pi calls execute(toolCallId, params, ...) — first arg is the ID,
            // the model's arguments come second. Getting this wrong sends the
            // id string as `arguments` and the server rejects it.
            const res = await this.callTool(name, tool.name, args);
            return normalizeMcpResult(res, resultBytesCap());
          },
        });
      }

      // Persist so restarts auto-reconnect (unless the user disconnects).
      const stored = loadServerConfigs();
      stored[name] = coerced;
      saveServerConfigs(stored);

      const serverLabel = client.serverInfo?.name ? `${client.serverInfo.name} ${client.serverInfo.version ?? ""}`.trim() : "server";
      const lines = [
        `Connected to MCP server "${name}" (${serverLabel}, transport ${coerced.transport}).`,
        `Registered ${entry.tools.length} tool(s)${tools.length > entry.tools.length ? ` — ${skipped.length} skipped (cap ${MAX_TOOLS_PER_SERVER}/server to protect the context window)` : ""}:`,
        ...entry.tools.map((t) => `  ${t.mcpName}: ${t.description ?? "(no description)"}`),
      ];
      return lines.join("\n");
    } catch (err: any) {
      await client.close().catch(() => {});
      this.servers.delete(name);
      throw new Error(`Failed to connect to MCP server "${name}": ${err?.message || err}`);
    }
  }

  async disconnect(nameArg: string, opts?: { forget?: boolean }): Promise<string> {
    const forget = opts?.forget !== false; // explicit disconnect forgets config; teardown keeps it
    const name = sanitizeToken(nameArg ?? "");
    const entry = this.servers.get(name);
    if (!entry) {
      const stored = loadServerConfigs();
      if (stored[name]) {
        delete stored[name];
        saveServerConfigs(stored);
        return `Server "${name}" was not connected; removed its persisted config.`;
      }
      throw new Error(`MCP server "${name}" is not connected.`);
    }
    for (const t of entry.tools) {
      this.hooks?.unregister(t.mcpName);
      try {
        piRemoveFromActiveToolset?.(t.mcpName);
      } catch {}
    }
    this.servers.delete(name);
    await entry.client.close().catch(() => {});
    if (forget) {
      const stored = loadServerConfigs();
      delete stored[name];
      saveServerConfigs(stored);
      return `Disconnected MCP server "${name}" (${entry.tools.length} tool(s) removed).`;
    }
    return `Disconnected MCP server "${name}" (${entry.tools.length} tool(s) removed); config kept for re-enable.`;
  }

  async callTool(serverName: string, toolName: string, args: any): Promise<any> {
    if (mcpDisabled()) throw new Error("The MCP adapter is DISABLED (/mcp-toggle).");
    const entry = this.servers.get(sanitizeToken(serverName));
    if (!entry) throw new Error(`MCP server "${serverName}" is not connected. Use mcp_connect first.`);
    return entry.client.callTool(toolName, args, callTimeoutMs());
  }

  async disconnectAll(): Promise<void> {
    // Used by the killswitch teardown: drop sessions but KEEP persisted
    // configs so /mcp-toggle on can auto-reconnect them.
    for (const name of Array.from(this.servers.keys())) {
      await this.disconnect(name, { forget: false }).catch(() => {});
    }
  }

  /** Auto-reconnect every persisted server at startup. Never throws. */
  async reconnectPersisted(): Promise<McpReconnectReport> {
    const report: McpReconnectReport = { connected: [], failed: [] };
    if (mcpDisabled()) return report;
    for (const [name, config] of Object.entries(loadServerConfigs())) {
      try {
        await this.connect(name, config);
        report.connected.push(name);
      } catch (err: any) {
        report.failed.push({ name, error: err?.message || String(err) });
      }
    }
    return report;
  }

  summary(): string {
    const disabled = mcpDisabled();
    const stored = Object.keys(loadServerConfigs());
    if (this.servers.size === 0) {
      return [
        disabled ? "MCP adapter: DISABLED (/mcp-toggle)." : "MCP adapter: enabled, no servers connected.",
        stored.length > 0 && !disabled
          ? `Persisted configs (not connected): ${stored.join(", ")}.`
          : "",
        "Use mcp_connect {command,args} for a local stdio server or {host,port} for a remote streamable-HTTP server.",
      ]
        .filter(Boolean)
        .join("\n");
    }
    const lines = [`MCP adapter: ${disabled ? "DISABLED (sessions will fail until re-enabled)" : "enabled"}. Connected servers:`];
    for (const [name, entry] of this.servers) {
      lines.push(`• ${name} (${entry.config.transport}, connected ${entry.connectedAt}): ${entry.tools.length} tool(s)`);
      for (const t of entry.tools) lines.push(`    ${t.mcpName}: ${t.description ?? "(no description)"}`);
    }
    return lines.join("\n");
  }
}

// Set by index.ts; avoids importing pi here. Filters one tool out of the
// live active toolset (pi has no unregisterTool, this is the only lever).
let piRemoveFromActiveToolset: ((toolName: string) => void) | null = null;
export function setMcpActiveToolsetRemover(fn: (toolName: string) => void): void {
  piRemoveFromActiveToolset = fn;
}

export function makeClient(config: McpServerConfig): McpClient {
  if (config.transport === "stdio") return new McpClient(new StdioMcpTransport(config));
  return new McpClient(new HttpMcpTransport(config));
}
