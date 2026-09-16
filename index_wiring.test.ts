/**
 * Offline wiring test for the MCP glue inside index.ts (no pi runtime, no
 * network): builtin registration, the before_agent_start union-merge, the
 * mcpkill.json killswitch, and the /mcp-toggle command. The live-transport
 * coverage lives in mcp.test.ts + run_mcp_smoke.sh.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-wire-"));
process.env.MYKYAGENT_MCP_FILE = join(DIR, "mcp.json");
process.env.MYKYAGENT_MCPKILL_FILE = join(DIR, "mcpkill.json");
// Keep the startup auto-reconnect pointed at the empty temp config.

const ext = (await import("./index.ts")).default;

let pass = 0,
  fail = 0;
const t = (name: string, ok: boolean, extra = "") => {
  if (ok) {
    pass++;
    console.log(` PASS  ${name}`);
  } else {
    fail++;
    console.log(` FAIL  ${name} ${extra}`);
  }
};

// --- mock pi runtime --------------------------------------------------------
const tools: Record<string, any> = {};
const commands: Record<string, any> = {};
const hooks: Record<string, any> = {};
let activeTools: string[] = [];
const pi: any = {
  on: (n: string, f: any) => (hooks[n] = f),
  registerTool: (def: any) => (tools[def.name] = def),
  registerCommand: (n: string, def: any) => (commands[n] = def),
  getActiveTools: () => [...activeTools],
  setActiveTools: (names: string[]) => (activeTools = [...names]),
};

await ext(pi);

// --- 1. registration --------------------------------------------------------
t("builtin mcp tools registered", !!(tools.mcp_connect && tools.mcp_disconnect && tools.mcp_list));
t("/mcp-toggle registered as a user command", !!commands["mcp-toggle"]);

// --- 2. before_agent_start merge includes mcp builtins ----------------------
activeTools = ["bash", "read"]; // pi fresh-session-ish snapshot
await hooks["before_agent_start"]({}, { cwd: DIR });
t("merge adds mcp builtins", activeTools.includes("mcp_connect") && activeTools.includes("mcp_list"), activeTools.join(","));
t("merge keeps pi tools", activeTools.includes("bash") && activeTools.includes("read"));

// --- 3. killswitch strips every mcp_* tool ----------------------------------
const { setMcpDisabled, mcpDisabled } = await import("./mcp.ts");
setMcpDisabled(true);
await hooks["before_agent_start"]({}, { cwd: DIR });
t("killswitch removes all mcp_* from active tools", activeTools.length > 0 && !activeTools.some((n) => n.startsWith("mcp_")), activeTools.join(","));
setMcpDisabled(false);
await hooks["before_agent_start"]({}, { cwd: DIR });
t("re-enable brings builtins back", activeTools.includes("mcp_connect"));

// --- 4. /mcp-toggle command --------------------------------------------------
const notify: string[] = [];
const cmdCtx = { ui: { notify: (msg: string) => notify.push(msg) } };
await commands["mcp-toggle"].handler("off", cmdCtx);
t("/mcp-toggle off persists killswitch", mcpDisabled() === true);
t("/mcp-toggle off strips mcp_* from live toolset", !activeTools.some((n) => n.startsWith("mcp_")));
await commands["mcp-toggle"].handler("on", cmdCtx);
t("/mcp-toggle on clears killswitch", mcpDisabled() === false && activeTools.includes("mcp_connect"));
await commands["mcp-toggle"].handler("status", cmdCtx);
t("/mcp-toggle status does not flip", mcpDisabled() === false);

// --- 5. builtin tool behaviors ----------------------------------------------
const bad = await tools.mcp_connect.execute("x", {});
t("mcp_connect rejects missing transport args", bad.isError === true, JSON.stringify(bad).slice(0, 120));
const listed = await tools.mcp_list.execute("x", {});
t("mcp_list reports adapter state", typeof listed.content?.[0]?.text === "string" && listed.content[0].text.includes("MCP adapter"));
const ghost = await tools.mcp_disconnect.execute("x", { server: "ghost" });
t("mcp_disconnect on unknown server errors", ghost.isError === true, JSON.stringify(ghost).slice(0, 120));

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
