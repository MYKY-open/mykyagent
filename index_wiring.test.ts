/**
 * Offline wiring test for the MCP glue inside index.ts (no pi runtime, no
 * network): builtin registration, the before_agent_start union-merge, the
 * mcpkill.json killswitch, and the /mcp-toggle command. The live-transport
 * coverage lives in mcp.test.ts + run_mcp_smoke.sh.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-wire-"));
process.env.MYKYAGENT_MCP_FILE = join(DIR, "mcp.json");
process.env.MYKYAGENT_MCPKILL_FILE = join(DIR, "mcpkill.json");
process.env.MYKYAGENT_WEBKILL_FILE = join(DIR, "webkill.json");
process.env.MYKYAGENT_WEBBROWSER_FILE = join(DIR, "webbrowser.json");
process.env.MYKYAGENT_TOGGLES_FILE = join(DIR, "toggles.json");
process.env.MYKYAGENT_MODE_FILE = join(DIR, "mode.json");
process.env.MYKYAGENT_EFFORT_FILE = join(DIR, "effort.json");
process.env.MYKYAGENT_STYLE_FILE = join(DIR, "style.json");
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
const sentMessages: string[] = [];
const pi: any = {
  on: (n: string, f: any) => (hooks[n] = f),
  sendUserMessage: (content: string) => sentMessages.push(content),
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
t("/mykyagent off bash disables bash", isToolEnabled("bash", "code") === false);
t("/mykyagent off bash leaves other modes alone", isToolEnabled("bash", "rp") === true);
t("/mykyagent off bash removes bash from live active tools", !activeTools.includes("bash"));

// before_agent_start keeps bash disabled
await hooks["before_agent_start"]({}, { cwd: DIR });
t("before_agent_start does not re-add disabled bash", !activeTools.includes("bash"));

// tool_call hook blocks disabled tool
const blockedCall = await hooks["tool_call"]({ toolName: "bash", input: { command: "ls" } });
t("tool_call blocks disabled bash", blockedCall?.block === true && blockedCall?.reason?.includes("disabled by /mykyagent"));

// Re-enable bash via /mykyagent on bash
await commands["mykyagent"].handler("on bash", cmdCtx);
t("/mykyagent on bash re-enables bash", isToolEnabled("bash", "code") === true);
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

// Picker overlay must render only strings: a hole (e.g. a stray `,,` in the
// header array) crashes pi's overlay compositing with "cannot read 'includes'".
{
  const piReal = await import("@earendil-works/pi-coding-agent");
  (piReal as any).initTheme("dark");
  let factory: any = null;
  await commands["mykyagent"].handler("", {
    cwd: DIR,
    ui: { notify: () => {}, custom: async (fn: any) => { factory = fn; return undefined; } },
  });
  t("picker factory created", typeof factory === "function");
  let doneCalled = false;
  const comp = factory({ requestRender: () => {} }, new Proxy({}, { get: (_t, p) => (...a: any[]) => a[a.length - 1] ?? "" }), {}, () => { doneCalled = true; });
  let bad = 0;
  for (const w of [20, 80, 120, 217]) {
    for (const line of comp.render(w)) if (typeof line !== "string") bad++;
    comp.handleInput("\x1b[B");
    for (const line of comp.render(w)) if (typeof line !== "string") bad++;
    comp.handleInput("\x1b");
  }
  t("picker renders only strings at every width", bad === 0);
  t("picker esc closes", doneCalled === true);
}

// --- 12. effort levels (/effort) -------------------------------------------
{
  const { setEffort } = await import("./effort.ts");
  t("/effort registered as a user command", !!commands["effort"]);
  const ec = commands["effort"].getArgumentCompletions("");
  t(
    "effort completions cover every level",
    Array.isArray(ec) && ["low", "high", "max"].every((l) => ec.some((c: any) => c.value === l))
  );

  setEffort("high");
  const start = await hooks["before_agent_start"]({}, { cwd: DIR });
  const prompt: string = start?.systemPrompt || "";
  t("effort=high block injected into prompt", prompt.includes("Work standard (effort=high)"), prompt.slice(0, 120));
  t("effort=high demands evidence", prompt.includes("Never claim success without evidence"));
  t("effort header line present", /Effort: high\./.test(prompt));
  t("persona voice untouched by effort", prompt.includes("Caveman") || prompt.includes("MykyAgent"));

  const notes: string[] = [];
  await commands["effort"].handler("", { cwd: DIR, ui: { notify: (m: string) => notes.push(m) } });
  t("/effort reports current level", notes.join(" ").includes("Effort: high"), notes.join(" ").slice(0, 120));

  await commands["effort"].handler("low", { cwd: DIR, ui: { notify: (m: string) => notes.push(m) } });
  const lowStart = await hooks["before_agent_start"]({}, { cwd: DIR });
  t("/effort low swaps the block", (lowStart?.systemPrompt || "").includes("Work standard (effort=low)"));
  t("/effort low drops high rules", !(lowStart?.systemPrompt || "").includes("never claim success without evidence".replace("never", "Never")));
  t("/verify registered as a user command", !!commands["verify"]);
  await commands["verify"].handler("the effort dial", { cwd: DIR, ui: { notify: () => {} } });
  const vmsg = sentMessages.at(-1) || "";
  t("/verify points at the verification skill", vmsg.includes("skill_read verification"), vmsg.slice(0, 120));
  t("/verify demands a PASS/FAIL verdict", vmsg.includes("PASS / PARTIAL / FAIL / UNVERIFIED"));
  t("/verify carries the scope", vmsg.includes("the effort dial"));
  t("/verify bans gut-feel proof", vmsg.includes('No "should work"'));

  // --- 12b. personas -------------------------------------------------------
  {
    const personaFile = join(DIR, "persona.json");
    process.env.MYKYAGENT_PERSONA_FILE = personaFile;
    const notes: string[] = [];
    const pctx = { cwd: DIR, ui: { notify: (m: string) => notes.push(m) } };
    await commands["persona"].handler("qa", pctx);
    t("/persona qa switches", readFileSync(personaFile, "utf-8").includes('"qa"'));
    const qaStart = await hooks["before_agent_start"]({}, { cwd: DIR });
    const qaPrompt: string = qaStart?.systemPrompt || "";
    t("qa persona voice in prompt", qaPrompt.includes("QA test engineer"));
    t("qa persona keeps the effort block separate", qaPrompt.includes("Work standard (effort="));
    await commands["persona"].handler("", { cwd: DIR, ui: { notify: (m: string) => notes.push(m) } });
    t("/persona list names the new voices", ["qa", "maintainer", "pm", "speedrunner", "gremlin"].every((k) => notes.join(" ").includes(k)));
    await commands["persona"].handler("gremlin", pctx);
    const gPrompt = (await hooks["before_agent_start"]({}, { cwd: DIR }))?.systemPrompt || "";
    t("gremlin voice in prompt", gPrompt.includes("a gremlin"));
    t("gremlin voice carries no depth rules", !gPrompt.includes("half-chewed"));
    t("gremlin asks before destructive moves", gPrompt.includes("destructive or irreversible gets a question"));
    // retired persona in an old config must not resurrect
    writeFileSync(join(DIR, "persona.json"), JSON.stringify({ current: "pirate" }), "utf-8");
    const retired = (await hooks["before_agent_start"]({}, { cwd: DIR }))?.systemPrompt || "";
    t("retired persona falls back to caveman", retired.includes("Caveman") && !retired.includes("Scurvy"));
    await commands["persona"].handler("caveman", pctx);
  }

  setEffort("high");
  // One message overrides the stored level for that turn only.
  const pre = await hooks["before_agent_start"]({ messageType: "user", prompt: "low: rename the var" }, { cwd: DIR });
  const prePrompt: string = pre?.systemPrompt || "";
  t("prefix low: injects the low block", prePrompt.includes("Work standard (effort=low)"));
  t("prefix low: header names the turn level", /Effort: low\./.test(prePrompt));
  t("prefix leaves the stored level alone", (await import("./effort.ts")).getEffort() === "high");
  const plain = await hooks["before_agent_start"]({ messageType: "user", prompt: "rename the var" }, { cwd: DIR });
  t("no prefix uses stored level", (plain?.systemPrompt || "").includes("Work standard (effort=high)"));

  // Feature toggled off: no block, no header, persona + goal still there.
  const { setFeatureEnabled } = await import("./toggles.ts");
  setFeatureEnabled("effort", false);
  const offPrompt: string = (await hooks["before_agent_start"]({ messageType: "user", prompt: "max: x" }, { cwd: DIR }))?.systemPrompt || "";
  t("feature off injects no block even with prefix", !offPrompt.includes("Work standard (effort="), offPrompt.slice(0, 200));
  t("feature off injects no effort header", !/Effort:/.test(offPrompt));
  t("feature off keeps persona + goal", offPrompt.includes("Goal: do the user task completely."));
  setFeatureEnabled("effort", true);
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

