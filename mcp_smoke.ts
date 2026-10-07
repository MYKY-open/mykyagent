/**
 * Smoke test for the MCP bridge (registry over pi native MCP, no pi runtime).
 *
 * Pi is stubbed: verifies session-server registration, persistence, and
 * teardown against a stub that mimics pi.registerMcpServer semantics.
 * Live transport coverage belongs to pi itself now; to check a REAL server
 * end to end, register it in pi (`pi mcp add ...`) and inspect /mcp.
 *
 * Run:  ./run_mcp_smoke.sh   (offline, no browser needed)
 */
import { McpRegistry, setMcpDisabled, loadServerConfigs } from "./mcp.ts";

process.env.MYKYAGENT_MCP_FILE = "/tmp/mykyagent-mcp-smoke.json";
process.env.MYKYAGENT_MCPKILL_FILE = "/tmp/mykyagent-mcp-smoke-kill.json";

let pass = 0,
  fail = 0;
const t = (name: string, ok: boolean, extra = "") => {
  ok ? pass++ : fail++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${name}${ok || !extra ? "" : `  ${extra}`}`);
};

// Stub pi with register/unregister/getMcpServers semantics.
const registered = new Map<string, any>();
const piStub = {
  registerMcpServer(name: string, config: any) {
    if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error(`invalid server name "${name}"`);
    registered.set(name, config);
  },
  unregisterMcpServer(name: string) {
    registered.delete(name);
  },
  getMcpServers() {
    return Array.from(registered.keys()).map((name) => ({ name }));
  },
};

const registry = new McpRegistry();
registry.attach(piStub);

// 1. Killswitch blocks connects.
setMcpDisabled(true);
let blocked = "";
try {
  await registry.connect("smoke", { command: "npx", args: ["-y", "x"] }, piStub);
} catch (e: any) {
  blocked = e.message;
}
t("killswitch blocks connect", blocked.includes("DISABLED"), blocked);
setMcpDisabled(false);

// 2. Register a stdio session server.
const report = await registry
  .connect("devtools", {
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:9222"],
  }, piStub)
  .then((r) => r, (e: any) => `ERROR: ${e?.message || e}`);
t("register stdio session server", !report.startsWith("ERROR") && registered.has("devtools"), String(report).slice(0, 200));

// 3. Register an HTTP session server (pi url shape).
const httpReport = await registry
  .connect("docs", { url: "http://127.0.0.1:3000/mcp" }, piStub)
  .then((r) => r, (e: any) => `ERROR: ${e?.message || e}`);
t("register http session server", !httpReport.startsWith("ERROR") && registered.get("docs")?.url === "http://127.0.0.1:3000/mcp", String(httpReport).slice(0, 200));

// 4. Summary shows session + persisted state with pi naming.
const summary = registry.summary(piStub);
t("summary reports bridge state", summary.includes("devtools") && summary.includes("mcp__<server>__<tool>"), summary.slice(0, 200));

// 5. Config persisted for restart re-registration.
t("config persisted", !!(loadServerConfigs() as any).devtools, JSON.stringify(loadServerConfigs()));

// 6. Reconnect path re-registers after a fresh registry (simulated restart).
const fresh = new McpRegistry();
fresh.attach(piStub);
registered.clear();
const rep = await fresh.reconnectPersisted(piStub);
t("reconnectPersisted re-registers", rep.connected.includes("devtools") && registered.has("devtools"), JSON.stringify(rep));

// 7. Clean disconnect forgets config.
const disc = await fresh.disconnect("devtools", piStub);
t("disconnect cleans up", !registered.has("devtools") && !fresh.isConnected("devtools"), disc);
await fresh.disconnect("docs", piStub).catch(() => {});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
