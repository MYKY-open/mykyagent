/**
 * MCP adapter: thin bridge over pi's NATIVE MCP support.
 *
 * pi now owns transports, OAuth, retries, logging, /mcp UI and the
 * mcp.json configs. This module only adds the agent-driven bit pi lacks:
 * `mcp_connect` / `mcp_disconnect` / `mcp_list` let the MODEL register a
 * server mid-chat via `pi.registerMcpServer()`, instead of the user editing
 * config files + /reload. Persisted session servers re-register on startup.
 *
 * Pi-free except for an optional api object (same idiom as search_hops.ts)
 * so it bundles standalone for unit tests. Never throws on a pi runtime
 * without MCP methods (older pi, wiring-test mocks) — registration is
 * best-effort there, persistence always works.
 *
 * Tool names are pi-style: `mcp__<server>__<tool>` (double underscore).
 * The killswitch helper `isMcpToolName()` also covers pi's resource tools.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types & config persistence (pi shape + legacy auto-migration)
// ---------------------------------------------------------------------------

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  description?: string;
}

export interface McpHttpConfig {
  url: string;
  headers?: Record<string, string>;
  description?: string;
}

/** Legacy mykyagent shape, auto-converted on load: {host, port, path?}. */
interface McpLegacyHttpConfig {
  host: string;
  port: number;
  path?: string;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

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

/**
 * Accept pi shapes ({command,...} / {url,...}), legacy mykyagent shapes
 * ({host,port,path?}, transport/type tags), and return normalized pi-shape
 * config. Null when hopeless.
 */
export function coerceConfig(cfg: any): McpServerConfig | null {
  if (!cfg || typeof cfg !== "object") return null;
  const c = cfg as any;

  if (typeof c.command === "string" && c.command.trim()) {
    const out: McpStdioConfig = { command: c.command.trim() };
    if (Array.isArray(c.args)) out.args = c.args.map(String);
    if (c.env && typeof c.env === "object" && !Array.isArray(c.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.env)) env[String(k)] = String(v);
      out.env = env;
    }
    if (typeof c.cwd === "string" && c.cwd) out.cwd = c.cwd;
    if (typeof c.description === "string" && c.description) out.description = c.description;
    return out;
  }

  if (typeof c.url === "string" && c.url.trim()) {
    const url = c.url.trim();
    if (!/^https?:\/\//.test(url)) return null;
    const out: McpHttpConfig = { url };
    if (c.headers && typeof c.headers === "object" && !Array.isArray(c.headers)) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.headers)) headers[String(k)] = String(v);
      out.headers = headers;
    }
    if (typeof c.description === "string" && c.description) out.description = c.description;
    return out;
  }

  // Legacy: {host, port, path?} -> {url}
  const port = Number(c.port);
  if (typeof c.host === "string" && c.host.trim() && Number.isInteger(port) && port > 0 && port < 65536) {
    const rawPath = typeof c.path === "string" && c.path ? c.path : "/mcp";
    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    return { url: `http://${c.host.trim()}:${port}${path}` };
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

/** Pi-style tool name: mcp__<server>__<tool> (double underscore, like pi). */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitizeToken(server)}__${sanitizeToken(tool)}`.slice(0, 64);
}

/** Namespace pi lists a server under: mcp__<server>. */
export function mcpNamespace(server: string): string {
  return `mcp__${sanitizeToken(server)}`;
}

const MCP_RESOURCE_TOOLS = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

/** True for pi MCP server tools, our mcp_connect/list/disconnect builtins, and pi's resource tools. */
export function isMcpToolName(name: string): boolean {
  if (!name) return false;
  if (name === "mcp_connect" || name === "mcp_disconnect" || name === "mcp_list") return true;
  if (name.startsWith("mcp_")) return true; // covers mcp__<server>__<tool> too
  return MCP_RESOURCE_TOOLS.has(name);
}

function defaultServerName(config: McpServerConfig): string {
  if ("command" in config) return sanitizeToken(config.command.split("/").pop() || "stdio");
  try {
    const u = new URL(config.url);
    return sanitizeToken(`${u.hostname}_${u.port || "http"}`);
  } catch {
    return "http";
  }
}

// ---------------------------------------------------------------------------
// Registry: session-server bookkeeping over pi.registerMcpServer
// ---------------------------------------------------------------------------

export interface McpReconnectReport {
  connected: string[];
  failed: { name: string; error: string }[];
}

interface PiMcpApi {
  registerMcpServer?: (name: string, config: any) => void;
  unregisterMcpServer?: (name: string) => void;
  getMcpServers?: () => { name: string }[];
}

export class McpRegistry {
  private session = new Set<string>();
  private pi: PiMcpApi | null = null;

  /** Attach the live pi object once (index.ts). All methods also accept an api arg. */
  attach(pi: PiMcpApi): void {
    this.pi = pi;
  }

  private api(explicit?: PiMcpApi | null): PiMcpApi | null {
    return explicit ?? this.pi;
  }

  serverNames(): string[] {
    return Object.keys(loadServerConfigs());
  }

  isConnected(name: string): boolean {
    return this.session.has(sanitizeToken(name));
  }

  async connect(nameArg: string | undefined, config: any, piArg?: PiMcpApi): Promise<string> {
    if (mcpDisabled()) {
      throw new Error("The MCP adapter is DISABLED (/mcp-toggle). Ask the user to re-enable it; do not retry.");
    }
    const coerced = coerceConfig(config);
    if (!coerced) {
      throw new Error(
        "Invalid MCP server config: need stdio {command, args?, env?, cwd?} or HTTP {url, headers?} (legacy {host, port, path?} also accepted)."
      );
    }
    const name = nameArg?.trim() ? sanitizeToken(nameArg.trim()) : defaultServerName(coerced);
    if (!name) throw new Error("Could not derive a server name; pass one explicitly.");

    const api = this.api(piArg ?? undefined);
    try {
      api?.registerMcpServer?.(name, coerced);
    } catch (err: any) {
      throw new Error(`pi refused MCP server "${name}": ${err?.message || err}`);
    }
    this.session.add(name);

    const stored = loadServerConfigs();
    stored[name] = coerced;
    saveServerConfigs(stored);

    const where = "command" in coerced ? `stdio ${coerced.command}` : coerced.url;
    return [
      `Registered MCP server "${name}" (${where}) with pi.`,
      `Tools appear as ${mcpNamespace(name)}__* once pi connects (background, a few seconds).`,
      `Check /mcp or mcp_list. A same-named entry in pi's mcp.json takes precedence.`,
      `Remove with mcp_disconnect.`,
    ].join("\n");
  }

  async disconnect(nameArg: string, piArg?: PiMcpApi, opts?: { forget?: boolean }): Promise<string> {
    const forget = opts?.forget !== false;
    const name = sanitizeToken(nameArg ?? "");
    const api = this.api(piArg ?? undefined);
    const wasSession = this.session.has(name);
    this.session.delete(name);
    try {
      api?.unregisterMcpServer?.(name);
    } catch {
      // Not ours / already gone — persistence cleanup below still applies.
    }
    if (forget) {
      const stored = loadServerConfigs();
      if (stored[name] || wasSession) {
        delete stored[name];
        saveServerConfigs(stored);
        return `Removed MCP server "${name}" (session registration dropped, persisted config forgotten).`;
      }
      throw new Error(`MCP server "${name}" is not known.`);
    }
    return `Unregistered MCP server "${name}" for this session; persisted config kept.`;
  }

  async disconnectAll(piArg?: PiMcpApi): Promise<void> {
    // Killswitch teardown: drop session registrations but KEEP persisted
    // configs so /mcp-toggle on can re-register them.
    const api = this.api(piArg ?? undefined);
    const names = new Set([...this.session, ...Object.keys(loadServerConfigs())]);
    for (const name of names) {
      try {
        api?.unregisterMcpServer?.(name);
      } catch {}
      this.session.delete(name);
    }
  }

  /** Re-register every persisted server. Never throws (startup-safe). */
  async reconnectPersisted(piArg?: PiMcpApi): Promise<McpReconnectReport> {
    const report: McpReconnectReport = { connected: [], failed: [] };
    if (mcpDisabled()) return report;
    const api = this.api(piArg ?? undefined);
    for (const [name, config] of Object.entries(loadServerConfigs())) {
      try {
        api?.registerMcpServer?.(name, config);
        this.session.add(name);
        report.connected.push(name);
      } catch (err: any) {
        report.failed.push({ name, error: err?.message || String(err) });
      }
    }
    return report;
  }

  summary(piArg?: PiMcpApi): string {
    const disabled = mcpDisabled();
    const stored = loadServerConfigs();
    const storedNames = Object.keys(stored);
    const api = this.api(piArg ?? undefined);
    let live: string[] = [];
    try {
      const servers = api?.getMcpServers?.();
      if (Array.isArray(servers)) live = servers.map((s: any) => String(s?.name ?? s)).filter(Boolean);
    } catch {}
    const lines: string[] = [
      disabled ? "MCP adapter: DISABLED (/mcp-toggle)." : "MCP adapter: enabled (pi native + session servers).",
    ];
    if (live.length > 0) lines.push(`Live pi servers: ${live.join(",")}.`);
    if (this.session.size > 0) lines.push(`Session servers (via mcp_connect): ${Array.from(this.session).join(",")}.`);
    if (storedNames.length > 0) {
      lines.push(`Persisted session servers: ${storedNames.join(",")}.`);
      for (const n of storedNames) {
        const c = stored[n];
        lines.push(`    ${n}: ${"command" in c ? `stdio ${c.command}` : c.url}`);
      }
    }
    if (live.length === 0 && this.session.size === 0 && storedNames.length === 0) {
      lines.push("No servers. pi's own mcp.json servers show in /mcp; session ones via mcp_connect.");
    }
    lines.push("Tools are pi-style mcp__<server>__<tool>. pi's /mcp shows connections, OAuth, errors.");
    lines.push("Use mcp_connect {command,args?,env?,cwd?} for stdio or {url,headers?} for HTTP (legacy {host,port,path?} ok).");
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Back-compat: index.ts used to wire a toolset remover for custom tools.
// Pi owns tool lifecycles now; kept as a no-op export so old imports don't break.
// ---------------------------------------------------------------------------
export function setMcpActiveToolsetRemover(_fn: (toolName: string) => void): void {}
