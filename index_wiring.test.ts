/**
 * Offline wiring test for the MCP glue inside index.ts (no pi runtime, no
 * network): builtin registration, the before_agent_start union-merge, the
 * mcpkill.json killswitch, and the /mcp-toggle command. The live-transport
 * coverage lives in mcp.test.ts + run_mcp_smoke.sh.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-wire-"));
process.env.MYKYAGENT_MCP_FILE = join(DIR, "mcp.json");
process.env.MYKYAGENT_MCPKILL_FILE = join(DIR, "mcpkill.json");
process.env.MYKYAGENT_WEBKILL_FILE = join(DIR, "webkill.json");
process.env.MYKYAGENT_WEBBROWSER_FILE = join(DIR, "webbrowser.json");
process.env.MYKYAGENT_TOGGLES_FILE = join(DIR, "toggles.json");
process.env.MYKYAGENT_MODE_FILE = join(DIR, "mode.json");
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

// --- 6. web browser override & /web-browser command -------------------------
t("web_fetch tool registered", !!tools.web_fetch);
t("web_fetch parameters include browser property", !!(tools.web_fetch?.parameters?.properties?.browser ?? tools.web_fetch?.parameters?.browser));
t("/web-browser registered as a user command", !!commands["web-browser"]);
t("/browser-toggle registered as an alias", !!commands["browser-toggle"]);

const comp = commands["web-browser"].getArgumentCompletions("");
t("web-browser argument completions return options", Array.isArray(comp) && comp.some((c: any) => c.value === "auto") && comp.some((c: any) => c.value === "on") && comp.some((c: any) => c.value === "off"));

const readBrowserFileMode = () => {
  const f = process.env.MYKYAGENT_WEBBROWSER_FILE!;
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf-8"))?.mode;
};

await commands["web-browser"].handler("on", cmdCtx);
t("/web-browser on persists force mode", readBrowserFileMode() === "force");

await commands["web-browser"].handler("off", cmdCtx);
t("/web-browser off persists off mode", readBrowserFileMode() === "off");

await commands["web-browser"].handler("auto", cmdCtx);
t("/web-browser auto persists auto mode", readBrowserFileMode() === "auto");

// bare toggle flips between auto and force
await commands["web-browser"].handler("", cmdCtx);
t("bare /web-browser flips auto to force", readBrowserFileMode() === "force");

await commands["web-browser"].handler("", cmdCtx);
t("bare /web-browser flips force to auto", readBrowserFileMode() === "auto");

await commands["web-browser"].handler("status", cmdCtx);
t("/web-browser status does not change mode", readBrowserFileMode() === "auto");

// --- 7. /mykyagent command & universal toggles ------------------------------
t("/mykyagent registered as a user command", !!commands["mykyagent"]);

const maComp = commands["mykyagent"].getArgumentCompletions("");
t(
  "mykyagent argument completions include subcommands",
  Array.isArray(maComp) &&
    maComp.some((c: any) => c.value === "status") &&
    maComp.some((c: any) => c.value === "toggle") &&
    maComp.some((c: any) => c.value === "reset")
);

const maToggleComp = commands["mykyagent"].getArgumentCompletions("toggle ");
t(
  "mykyagent toggle completions list items",
  Array.isArray(maToggleComp) &&
    maToggleComp.some((c: any) => c.value.includes("bash")) &&
    maToggleComp.some((c: any) => c.value.includes("memory"))
);

// Disable a tool via /mykyagent off bash
await commands["mykyagent"].handler("off bash", cmdCtx);
const { isToolEnabled, isFeatureEnabled, isSkillEnabled } = await import("./toggles.ts");
t("/mykyagent off bash disables bash", isToolEnabled("bash") === false);
t("/mykyagent off bash removes bash from live active tools", !activeTools.includes("bash"));

// before_agent_start keeps bash disabled
await hooks["before_agent_start"]({}, { cwd: DIR });
t("before_agent_start does not re-add disabled bash", !activeTools.includes("bash"));

// tool_call hook blocks disabled tool
const blockedCall = await hooks["tool_call"]({ toolName: "bash", input: { command: "ls" } });
t("tool_call blocks disabled bash", blockedCall?.block === true && blockedCall?.reason?.includes("disabled by /mykyagent"));

// Re-enable bash via /mykyagent on bash
await commands["mykyagent"].handler("on bash", cmdCtx);
t("/mykyagent on bash re-enables bash", isToolEnabled("bash") === true);
await hooks["before_agent_start"]({}, { cwd: DIR });
t("before_agent_start restores enabled bash", activeTools.includes("bash"));

const allowedCall = await hooks["tool_call"]({ toolName: "bash", input: { command: "ls" } });
t("tool_call does not block enabled bash", !allowedCall?.block);

// Test feature toggle: memory
await commands["mykyagent"].handler("off memory", cmdCtx);
t("/mykyagent off memory disables memory feature", isFeatureEnabled("memory") === false);
await hooks["before_agent_start"]({}, { cwd: DIR });
t("before_agent_start removes memory tools when memory feature is off", !activeTools.some((t) => t.startsWith("memory_")));

// Test skill inclusion & toggle in systemPrompt
const promptRes1 = await hooks["before_agent_start"](
  {
    systemPromptOptions: {
      skills: [
        {
          name: "web-scraping",
          description: "Scrape web pages",
          filePath: "/path/to/SKILL.md",
        },
      ],
    },
  },
  { cwd: DIR }
);
t("skills formatted in system prompt when enabled", promptRes1?.systemPrompt?.includes("web-scraping"));

await commands["mykyagent"].handler("off web-scraping", cmdCtx);
t("skill web-scraping disabled", isSkillEnabled("web-scraping") === false);

const promptRes2 = await hooks["before_agent_start"](
  {
    systemPromptOptions: {
      skills: [
        {
          name: "web-scraping",
          description: "Scrape web pages",
          filePath: "/path/to/SKILL.md",
        },
      ],
    },
  },
  { cwd: DIR }
);
t("disabled skill omitted from system prompt", !promptRes2?.systemPrompt?.includes("web-scraping"));

// Reset all toggles
await commands["mykyagent"].handler("reset", cmdCtx);
t("reset restores memory feature", isFeatureEnabled("memory") === true);
t("reset restores skill", isSkillEnabled("web-scraping") === true);
t("reset restores tool", isToolEnabled("bash") === true);

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

