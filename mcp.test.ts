/**
 * Offline tests for the MCP bridge (mcp.ts over pi native MCP).
 *
 * Load-bearing properties: tool names match pi's mcp__<server>__<tool> shape,
 * legacy {host,port} configs migrate to {url}, persistence round-trips, the
 * killswitch blocks connects, and the registry drives pi.registerMcpServer /
 * unregisterMcpServer instead of owning transports. pi is a stub here.
 */
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-mcp-"));
process.env.MYKYAGENT_MCP_FILE = join(DIR, "mcp.json");
process.env.MYKYAGENT_MCPKILL_FILE = join(DIR, "mcpkill.json");

const M = await import("./mcp.ts");

let pass = 0,
  fail = 0;
const t = (name: string, cond: boolean, extra = "") => {
  if (cond) {
    pass++;
    console.log(` PASS  ${name}`);
  } else {
    fail++;
    console.log(` FAIL  ${name} ${extra}`);
  }
};
const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

// --- stub pi ---------------------------------------------------------------
const makePi = () => {
  const registered = new Map<string, any>();
  return {
    registered,
    registerMcpServer(name: string, config: any) {
      registered.set(name, config);
    },
    unregisterMcpServer(name: string) {
      registered.delete(name);
    },
    getMcpServers() {
      return Array.from(registered.keys()).map((name) => ({ name }));
    },
  };
};

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

t("sanitizeToken lowercases and collapses junk", M.sanitizeToken("Hello World!! 42") === "hello_world_42", M.sanitizeToken("Hello World!! 42"));
t("sanitizeToken strips leading/trailing underscores", M.sanitizeToken("__foo--bar__") === "foo_bar");
t("sanitizeToken caps length", M.sanitizeToken("x".repeat(100)).length === 24);
t("mcpToolName is pi-style double underscore", M.mcpToolName("Chrome DevTools", "take_screenshot!") === "mcp__chrome_devtools__take_screenshot");
t("mcpToolName caps total length", M.mcpToolName("s".repeat(40), "t".repeat(40)).length <= 64);
t("distinct servers produce distinct prefixes", (() => {
  const a = M.mcpToolName("server-a", "echo");
  const b = M.mcpToolName("server-b", "echo");
  return a.startsWith("mcp__server_a__") && b.startsWith("mcp__server_b__") && a !== b;
})());
t("same server name in different spellings collides by design", M.mcpToolName("a-b", "x") === M.mcpToolName("a_b", "x"));
t("mcpNamespace matches tool prefix", M.mcpNamespace("Dev Tools") === "mcp__dev_tools");

t("isMcpToolName covers builtins", M.isMcpToolName("mcp_connect") && M.isMcpToolName("mcp_disconnect") && M.isMcpToolName("mcp_list"));
t("isMcpToolName covers pi server tools", M.isMcpToolName("mcp__devtools__echo") && M.isMcpToolName("mcp_old_single"));
t("isMcpToolName covers pi resource tools", M.isMcpToolName("list_mcp_resources") && M.isMcpToolName("read_mcp_resource"));
t("isMcpToolName passes normal tools", !M.isMcpToolName("bash") && !M.isMcpToolName("read") && !M.isMcpToolName(""));

// ---------------------------------------------------------------------------
// 2. Config coercion + persistence + killswitch
// ---------------------------------------------------------------------------

t("coerceConfig: stdio from command", (() => {
  const c: any = M.coerceConfig({ command: "npx", args: ["-y", "x"], env: { K: "v" }, cwd: "/tmp" });
  return c?.command === "npx" && c?.args?.[0] === "-y" && c?.env?.K === "v" && c?.cwd === "/tmp" && !("transport" in c);
})());
t("coerceConfig: http from url", (() => {
  const c: any = M.coerceConfig({ url: "http://10.0.0.5:3000/mcp", headers: { Authorization: "Bearer x" } });
  return c?.url === "http://10.0.0.5:3000/mcp" && c?.headers?.Authorization === "Bearer x";
})());
t("coerceConfig: legacy host/port migrates to url", (() => {
  const c: any = M.coerceConfig({ host: "10.0.0.5", port: "9222" });
  return c?.url === "http://10.0.0.5:9222/mcp";
})());
t("coerceConfig: legacy custom path kept", (() => {
  const c: any = M.coerceConfig({ host: "h", port: 1, path: "custom" });
  return c?.url === "http://h:1/custom";
})());
t("coerceConfig: rejects garbage", M.coerceConfig({ host: "x" }) === null && M.coerceConfig(null) === null && M.coerceConfig({ port: 99999 }) === null && M.coerceConfig({ url: "not-a-url" }) === null);

t("server configs persist round-trip", (() => {
  M.saveServerConfigs({ devtools: { command: "npx", args: ["-y", "@chrome-devtools/mcp"] } });
  const loaded = M.loadServerConfigs();
  return (loaded.devtools as any)?.command === "npx" && existsSync(M.mcpConfigFile());
})());
t("legacy persisted host/port loads as url", (() => {
  writeFileSync(M.mcpConfigFile(), JSON.stringify({ servers: { old: { host: "h", port: 1 } } }), "utf-8");
  const loaded: any = M.loadServerConfigs();
  return loaded.old?.url === "http://h:1/mcp";
})());
t("loadServerConfigs survives corrupt json", (() => {
  writeFileSync(M.mcpConfigFile(), "{broken", "utf-8");
  return eq(M.loadServerConfigs(), {});
})());

t("killswitch defaults to enabled", M.mcpDisabled() === false);
t("killswitch flips and persists", (() => {
  M.setMcpDisabled(true);
  const on = M.mcpDisabled();
  M.setMcpDisabled(false);
  return on === true && M.mcpDisabled() === false;
})());

// ---------------------------------------------------------------------------
// 3. Registry bridge over stub pi
// ---------------------------------------------------------------------------

{
  M.saveServerConfigs({});
  const pi = makePi();
  const reg = new M.McpRegistry();
  reg.attach(pi);

  let blocked = "";
  M.setMcpDisabled(true);
  try {
    await reg.connect("x", { command: "true" });
  } catch (e: any) {
    blocked = e.message;
  }
  M.setMcpDisabled(false);
  t("registry: connect refused while killswitched", blocked.includes("DISABLED"), blocked);

  let bad = "";
  try {
    await reg.connect("bad", { host: "only-host" });
  } catch (e: any) {
    bad = e.message;
  }
  t("registry: invalid config rejected, nothing persisted", bad.includes("Invalid") && !reg.isConnected("bad") && eq(M.loadServerConfigs(), {}), bad);

  const report = await reg.connect("devtools", { command: "npx", args: ["-y", "x"] });
  t("registry: connect registers with pi", pi.registered.has("devtools"), report);
  t("registry: connect message names pi-style tools", report.includes("mcp__devtools__"), report);
  t("registry: config persisted on connect", (M.loadServerConfigs().devtools as any)?.command === "npx");
  t("registry: serverNames tracks persisted", reg.serverNames().includes("devtools"));

  const httpReport = await reg.connect("remote", { url: "http://10.0.0.5:3000/mcp" }, pi);
  t("registry: explicit pi arg works", pi.registered.get("remote")?.url === "http://10.0.0.5:3000/mcp", httpReport);

  const legacy = await reg.connect("oldhost", { host: "10.0.0.5", port: 9222 }, pi);
  t("registry: legacy host/port migrated on connect", pi.registered.get("oldhost")?.url === "http://10.0.0.5:9222/mcp", legacy);

  const summary = reg.summary(pi);
  t("registry: summary lists servers and pi naming", summary.includes("devtools") && summary.includes("mcp__<server>__<tool>"), summary);

  const disc = await reg.disconnect("devtools", pi);
  t("registry: disconnect unregisters from pi", !pi.registered.has("devtools") && !reg.isConnected("devtools"), disc);
  t("registry: disconnect forgets persisted config", M.loadServerConfigs().devtools === undefined);

  // disconnectAll (killswitch teardown) KEEPS persisted config
  await reg.connect("keeper", { command: "true" }, pi);
  await reg.disconnectAll(pi);
  t("registry: disconnectAll drops session but keeps config", !pi.registered.has("keeper") && (M.loadServerConfigs().keeper as any)?.command === "true");

  // reconnectPersisted re-registers without throwing
  const rep = await reg.reconnectPersisted(pi);
  t("registry: reconnectPersisted re-registers", rep.connected.includes("keeper") && pi.registered.has("keeper"), JSON.stringify(rep));

  // killswitched reconnect is a no-op
  M.setMcpDisabled(true);
  pi.registered.clear();
  const rep2 = await reg.reconnectPersisted(pi);
  t("registry: killswitched reconnect does nothing", rep2.connected.length === 0 && pi.registered.size === 0);
  M.setMcpDisabled(false);

  // pi that throws on register surfaces cleanly
  const throwingPi = { registerMcpServer: () => { throw new Error("bad name!"); } };
  let refused = "";
  try {
    await reg.connect("y", { command: "true" }, throwingPi as any);
  } catch (e: any) {
    refused = e.message;
  }
  t("registry: pi refusal surfaces", refused.includes("pi refused"), refused);

  // registry tolerates a pi runtime without MCP methods (old pi / mocks)
  const barePi: any = {};
  const bare = await reg.connect("bare", { command: "true" }, barePi);
  t("registry: pi without MCP methods still persists", typeof bare === "string" && (M.loadServerConfigs().bare as any)?.command === "true", bare);

  let unknown = "";
  try {
    await reg.disconnect("ghost", pi);
  } catch (e: any) {
    unknown = e.message;
  }
  t("registry: disconnect on unknown server errors clearly", unknown.includes("not known"), unknown);
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
