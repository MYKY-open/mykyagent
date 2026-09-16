/**
 * Live smoke test for the MCP adapter (mcp.ts registry only, no pi runtime).
 *
 * Target: the locally running chrome-devtools-mcp bridging to the browser's
 * CDP endpoint on 127.0.0.1:9222 (spawned over stdio — the real-world case).
 *
 *   npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222
 *
 * Run:  ./run_mcp_smoke.sh
 */
import { McpRegistry, mcpDisabled, setMcpDisabled, loadServerConfigs } from "./mcp.ts";

process.env.MYKYAGENT_MCP_FILE = "/tmp/mykyagent-mcp-smoke.json";
process.env.MYKYAGENT_MCPKILL_FILE = "/tmp/mykyagent-mcp-smoke-kill.json";
process.env.MYKYAGENT_MCP_LOG = "/tmp/mykyagent-mcp-smoke-stderr.log";
process.env.MYKYAGENT_MCP_INIT_TIMEOUT = "60000";

let pass = 0,
  fail = 0;
const t = (name: string, ok: boolean, extra = "") => {
  ok ? pass++ : fail++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${name}${ok || !extra ? "" : `  ${extra}`}`);
};

const registry = new McpRegistry();
const registered: string[] = [];
registry.hooks = {
  register: (def) => registered.push(def.name),
  unregister: (name) => {
    const i = registered.indexOf(name);
    if (i >= 0) registered.splice(i, 1);
  },
};

// 1. Killswitch blocks connects.
setMcpDisabled(true);
let blocked = "";
try {
  await registry.connect("smoke", { transport: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] });
} catch (e: any) {
  blocked = e.message;
}
t("killswitch blocks connect", blocked.includes("DISABLED"), blocked);
setMcpDisabled(false);

// 2. Live connect via stdio to the browser bridge.
const report = await registry
  .connect("devtools", {
    transport: "stdio",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:9222"],
  })
  .then((r) => r, (e: any) => `ERROR: ${e?.message || e}`);

const connected = !report.startsWith("ERROR");
t("live connect over stdio", connected, String(report).slice(0, 300));
if (connected) {
  console.log(`--- discovered ${registered.length} tools ---`);
  console.log(registered.slice(0, 12).join(", ") + (registered.length > 12 ? " ..." : ""));

  // 3. Call a harmless read-only tool. list_pages exists across versions;
  // fall back to the first registered tool if the names shifted.
  const target = registered.find((n) => n === "mcp_devtools_list_pages") ?? registered[0];
  const original = target.replace(/^mcp_devtools_/, "");
  const res = await registry.callTool("devtools", original, {}).then(
    (r: any) => r,
    (e: any) => ({ isError: true, content: [{ type: "text", text: String(e?.message || e) }] })
  );
  const text = res?.content?.map((c: any) => c.text || "").join(" ") || "";
  t("live tools/call returns content", !res.isError && text.length > 0, text.slice(0, 200));

  // 4. Config persisted for restart auto-reconnect.
  t("config persisted", !!loadServerConfigs().devtools, JSON.stringify(loadServerConfigs()));

  // 5. Clean disconnect removes everything.
  const disc = await registry.disconnect("devtools");
  t("disconnect cleans up", registered.length === 0 && !registry.isConnected("devtools"), disc);
} else {
  console.log("NOTE: live server not reachable — this is fatal for the smoke test.");
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
