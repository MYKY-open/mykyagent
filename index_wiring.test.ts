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
process.env.MYKYAGENT_BRIEF_FILE = join(DIR, "brief.json");
process.env.MYKYAGENT_PROFILES_DIR = join(DIR, "profiles");
process.env.MYKYAGENT_MEMORY_DIR = join(DIR, "memory");
process.env.MYKYAGENT_TASKS_DIR = join(DIR, "tasks");
process.env.MYKYAGENT_PROFILE_FILE = join(DIR, "profile.json");
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
// pi defines a tool for every platform: powershell on Linux is a definition
// that cannot run, plus one hidden tool that must never be listed.
const ALL_TOOLS = [
  { name: "bash", exposure: "direct" },
  { name: "read", exposure: "direct" },
  { name: "powershell", exposure: "direct" },
  { name: "ghostpaneltool", exposure: "hidden" },
];
const pi: any = {
  on: (n: string, f: any) => (hooks[n] = f),
  sendUserMessage: (content: string) => sentMessages.push(content),
  registerTool: (def: any) => (tools[def.name] = def),
  registerCommand: (n: string, def: any) => (commands[n] = def),
  getActiveTools: () => [...activeTools],
  getAllTools: () => [...ALL_TOOLS],
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

// --- 2b. skills master also drops the skill_read tool -----------------------
{
  const { setSkillsMasterEnabled } = await import("./toggles.ts");
  activeTools = ["bash", "skill_read"];
  setSkillsMasterEnabled(false);
  await hooks["before_agent_start"]({}, { cwd: DIR });
  t("skills master off removes skill_read from the toolset", !activeTools.includes("skill_read") && activeTools.includes("bash"), activeTools.join(","));
  setSkillsMasterEnabled(true);
  await hooks["before_agent_start"]({}, { cwd: DIR });
  t("skills master on restores skill_read", activeTools.includes("skill_read"), activeTools.join(","));
}

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
  const { setFeatureEnabled: setFeatureEarly } = await import("./toggles.ts");
  setFeatureEarly("effort", true); // opt-in feature: tests opt in
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
  t("effort=high: size-to-change rule present", prompt.includes("Size the ceremony to the change"));
  t("effort=high: one planning ritual (no separate 3-5 step plan)", !prompt.includes("state a simple 3-5 step plan"));
  t("scope rule present in code prompt", prompt.includes("Change only what was asked"));
  t("path rule: absolute paths inside the project are allowed", prompt.includes("Absolute paths inside the working directory are fine"));
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
  t("/verify sizes the pass to the scope", vmsg.includes("size the pass to this scope"));
  // Storing a level is an explicit ask: it turns the opt-in feature on.
  setFeatureEarly("effort", false);
  await commands["effort"].handler("high", { cwd: DIR, ui: { notify: () => {} } });
  t("/effort <level> enables the feature", (await import("./toggles.ts")).isFeatureEnabled("effort") === true);

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

  // RP / Story Studio prose never carries the stored build standard.
  const { setMode } = await import("./mode.ts");
  setEffort("max");
  setMode("rp");
  const rpPlain: string = (await hooks["before_agent_start"]({ messageType: "user", prompt: "*she looks up*" }, { cwd: DIR }))?.systemPrompt || "";
  t("stored max does not reach an rp turn", !rpPlain.includes("Work standard (effort="), rpPlain.slice(0, 160));
  t("rp turn carries no effort header", !/Effort: (low|high|max)\./.test(rpPlain));
  const rpTyped: string = (await hooks["before_agent_start"]({ messageType: "user", prompt: "max: write the duel" }, { cwd: DIR }))?.systemPrompt || "";
  t("rp turn ignores even a typed prefix (own prompt)", !rpTyped.includes("Work standard (effort="));
  setMode("rp-creator");
  const creatorPlain: string = (await hooks["before_agent_start"]({ messageType: "user", prompt: "draft a rival" }, { cwd: DIR }))?.systemPrompt || "";
  t("stored max does not reach rp-creator", !creatorPlain.includes("Work standard (effort="), creatorPlain.slice(0, 160));
  const creatorTyped: string = (await hooks["before_agent_start"]({ messageType: "user", prompt: "high: draft a rival" }, { cwd: DIR }))?.systemPrompt || "";
  t("rp-creator honors a typed prefix", creatorTyped.includes("Work standard (effort=high)"));
  setMode("code");
  // narrative dials (style.json momentum=active) stay out of coding prompts, still reach rp-creator
  writeFileSync(process.env.MYKYAGENT_STYLE_FILE!, JSON.stringify({ momentum: "active" }), "utf-8");
  const codeStyled = (await hooks["before_agent_start"]({}, { cwd: DIR }))?.systemPrompt || "";
  t("style dials absent from code prompt", !codeStyled.includes("Narrative style"), codeStyled.slice(0, 120));
  setMode("rp-creator");
  const creatorStyled = (await hooks["before_agent_start"]({ messageType: "user", prompt: "draft a rival" }, { cwd: DIR }))?.systemPrompt || "";
  t("style dials still reach rp-creator", creatorStyled.includes("active plot: move the scene forward"));
  setMode("code");
  setEffort("high");

  // --- 12c. profiles (/profile, /mykyagent profile) ------------------------
  {
    const { getEffort, setEffort: setEffort2 } = await import("./effort.ts");
    const { listProfiles, getActiveProfile } = await import("./profiles.ts");
    setFeatureEarly("effort", true);
    const notes: string[] = [];
    const statuses: { key: string; text: string }[] = [];
    const pctx = {
      cwd: DIR,
      ui: {
        notify: (m: string) => notes.push(m),
        setStatus: (key: string, text: string) => statuses.push({ key, text }),
      },
    };
    t("/profile registered as a user command", !!commands["profile"]);
    t("/mykyagent exposes the profile subcommand", commands["mykyagent"].getArgumentCompletions("pro").some((c: any) => c.value === "profile"));

    setEffort2("max");
    await commands["profile"].handler("new Quest Night", pctx);
    t("/profile new creates and activates", getActiveProfile() === "quest-night" && notes.at(-1)!.includes("activated"));
    t("profile snapshot stores effort", listProfiles()[0].effort === "max");

    const verbs = commands["profile"].getArgumentCompletions("");
    t("/profile completions list every verb", ["list", "new", "use", "save", "delete", "rename"].every((v) => verbs.some((c: any) => c.value === v)));
    const byName = commands["profile"].getArgumentCompletions("use ");
    t("/profile completions offer saved profiles", byName.some((c: any) => c.value === "use quest-night"));

    setEffort2("low");
    await commands["profile"].handler("new Ship Mode", pctx);
    t("second profile snapshots low", listProfiles().some((p) => p.slug === "ship-mode" && p.effort === "low"));

    await commands["profile"].handler("use Quest Night", pctx);
    t("/profile use switches the live effort", getEffort() === "max");
    t("footer line carries profile + effort", statuses.at(-1)?.key === "mykyagent" && statuses.at(-1)!.text.includes("Quest Night") && statuses.at(-1)!.text.includes("max"), JSON.stringify(statuses.at(-1)));

    // Self-heal on the next turn, without a command: change effort behind the
    // footer's back and let before_agent_start repaint it.
    setEffort2("low");
    await hooks["before_agent_start"]({ messageType: "user", prompt: "hi" }, pctx);
    t("footer repaints on the next turn", statuses.at(-1)!.text.includes("effort low"), JSON.stringify(statuses.at(-1)));
    const before = statuses.length;
    await hooks["before_agent_start"]({ messageType: "user", prompt: "hi" }, pctx);
    t("footer does not repaint unchanged state", statuses.length === before, `${before} -> ${statuses.length}`);
    await commands["profile"].handler("use quest night", pctx);
    t("footer repaints after a profile switch", statuses.at(-1)!.text.includes("Quest Night") && statuses.at(-1)!.text.includes("max"), JSON.stringify(statuses.at(-1)));
    t("/profile use saved the outgoing profile", listProfiles().find((p) => p.slug === "ship-mode")?.effort === "low");

    await commands["profile"].handler("save", pctx);
    t("/profile save writes the active profile", listProfiles().find((p) => p.slug === "quest-night")?.effort === "max");

    // End-to-end: the restored level reaches the prompt, and toggles come back too.
    const restoredPrompt: string = (await hooks["before_agent_start"]({ messageType: "user", prompt: "go" }, { cwd: DIR }))?.systemPrompt || "";
    t("restored effort reaches the prompt", restoredPrompt.includes("Work standard (effort=max)"), restoredPrompt.slice(0, 120));
    setFeatureEarly("style", false);
    await commands["profile"].handler("save", pctx);
    setFeatureEarly("style", true);
    await commands["profile"].handler("use quest-night", pctx);
    const { isFeatureEnabled: isFeat } = await import("./toggles.ts");
    t("restored toggles reach the live store", isFeat("style") === false);
    setFeatureEarly("style", true);
    await commands["profile"].handler("save", pctx);

    // Routing through the board keeps one implementation.
    notes.length = 0;
    await commands["mykyagent"].handler("profile list", pctx);
    t("/mykyagent profile list shows the card", notes.join("\n").includes("Quest Night") && notes.join("\n").includes("active"));

    notes.length = 0;
    await commands["mykyagent"].handler("profile use ship mode", pctx);
    t("/mykyagent profile use switches", getEffort() === "low");

    notes.length = 0;
    await commands["profile"].handler("delete Ship Mode", pctx);
    t("/profile delete removes it", !listProfiles().some((p) => p.slug === "ship-mode") && notes.at(-1)!.includes("deleted"), notes.at(-1));

    notes.length = 0;
    await commands["profile"].handler("use nope", pctx);
    t("/profile use unknown reports an error, no throw", notes.at(-1)!.includes("No profile named"));

    // Status card names the profile and the effort state.
    notes.length = 0;
    await commands["mykyagent"].handler("status", pctx);
    t("status card shows profile + effort", notes.join("\n").includes("Profile:") && notes.join("\n").includes("Effort:"));

    // Platform/runnability filter: powershell and hidden tools never appear.
    t("status card hides powershell off Windows", process.platform === "win32" || !notes.join("\n").includes("powershell"), notes.join("\n").slice(0, 200));
    t("status card hides hidden-exposure tools", !notes.join("\n").includes("ghostpaneltool"));

    // A profile switch must not activate tools that were not active.
    activeTools = ["bash", "read"];
    const beforeSwitch = [...activeTools];
    await commands["profile"].handler("use quest-night", pctx);
    t("profile switch does not activate dormant definitions", !activeTools.includes("powershell") && !activeTools.includes("ghostpaneltool"), activeTools.join(","));
    t("profile switch keeps the active tools it had", beforeSwitch.every((n) => activeTools.includes(n)), activeTools.join(","));

    // `new <name> --default`: seed a profile from the factory defaults.
    setEffort2("max");
    notes.length = 0;
    await commands["profile"].handler("new Reset Point --default", pctx);
    const seeded = listProfiles().find((p) => p.slug === "reset-point");
    t("/profile new --default seeds the factory effort", seeded?.effort === "high" && seeded?.sections.join(",") === "effort,persona,style,brief,toggles", JSON.stringify(seeded));
    t("/profile new --default does not steal the active slot", getActiveProfile() === "quest-night" && notes.at(-1)!.includes("not activated"), notes.at(-1));
    t("/profile new --default leaves the live settings alone", getEffort() === "max");
    const { isFeatureEnabled: isFeatPre } = await import("./toggles.ts");
    t("seeded toggles carry no live overrides", isFeatPre("effort") === true);

    notes.length = 0;
    await commands["profile"].handler("use Reset Point", pctx);
    t("/profile use applies the seeded defaults", getEffort() === "high" && getActiveProfile() === "reset-point", `${getEffort()} ${getActiveProfile()}`);

    notes.length = 0;
    await commands["profile"].handler("new Broken --bogus", pctx);
    t("/profile new rejects an unknown option", notes.at(-1)!.includes("Unknown option") && !listProfiles().some((p) => p.slug === "broken"), notes.at(-1));

    notes.length = 0;
    await commands["profile"].handler("delete Reset Point", pctx);
    await commands["profile"].handler("use quest-night", pctx);
    t("/profile use still names the defaults card", commands["profile"].description.includes("--default"));
  }
}

// --- 12d. status footer + board colors -------------------------------------
{
  const { fitFooterLine } = await import("./index.ts");
  const { visibleWidth } = await import("@earendil-works/pi-tui");

  // Same line as the model; the suffix is self-contained, so ANSI in the line
  // can neither bleed into it nor lose its own color.
  const line = "↑1k ↓2k 4%/200k" + " ".repeat(20) + "deepseek-v4.1-flash";
  const out = fitFooterLine(line, " · Story Night · effort max", 60);
  t("footer keeps stats, model and status on one line", visibleWidth(out) <= 60 && out.includes("Story Night"), `${visibleWidth(out)}: ${JSON.stringify(out)}`);
  t("footer suffix comes last", out.endsWith(" · Story Night · effort max"));
  // The inner footer is re-rendered at (width - suffix), so the model is laid
  // out inside that room by pi itself; the helper only appends at the end.
  const roomy = fitFooterLine("↑1k ↓2k 4%/200k      model", " · x", 40);
  t("footer leaves the model alone", roomy.includes("model") && roomy.endsWith(" · x"), JSON.stringify(roomy));
  t("footer appends when there is room", fitFooterLine("hi", " · x", 20) === "hi · x");
  t("footer grows an empty line", fitFooterLine("", " status", 20).includes("status"));
  const narrow = fitFooterLine("↑1k ↓2k" + " ".repeat(30) + "model", " · Story Night · effort max", 20);
  t("footer keeps the suffix on a narrow terminal", narrow.endsWith(" · Story Night · effort max"), JSON.stringify(narrow));
  const { insertStatusBeforeModel } = await import("./index.ts");
  const base = "↑1k ↓2k 45%/200k" + " ".repeat(30) + "(prov) model • high";
  const ins = insertStatusBeforeModel(base, " · Story Night · max");
  t("footer status lands before the model", ins !== null && ins.indexOf("Story Night") < ins.indexOf("(prov) model"), JSON.stringify(ins));
  t("footer keeps its exact width when inserting", ins !== null && visibleWidth(ins) === visibleWidth(base), `${ins ? visibleWidth(ins) : "-"} vs ${visibleWidth(base)}`);
  t("footer leaves a space before the model", ins !== null && / max +\(prov\) model/.test(ins), JSON.stringify(ins));
  t("footer refuses when the padding is too small", insertStatusBeforeModel("stats  model", " · Story Night · max") === null);
  const ansi = fitFooterLine("\u001b[38;5;245mstats      model\u001b[39m", " · \u001b[38;5;245mdim x\u001b[39m", 40);
  t("footer does not re-color the model line", ansi.includes("model") && ansi.endsWith("\u001b[39m"), JSON.stringify(ansi));

  // Footer install: one custom footer, status rendered, repaint on change only.
  const statuses: { text?: string }[] = [];
  let renders = 0;
  let installed = 0;
  let factory: any = null;
  const footerUi = {
    notify: () => {},
    setStatus: (_k: string, text: string) => statuses.push({ text }),
    setFooter: (f: any) => {
      factory = f;
      installed++;
    },
    requestRender: () => {
      renders++;
    },
  };
  const fakeTheme = { fg: (_t: string, s: string) => `«${s}»`, bold: (s: string) => `*${s}*` };
  await hooks["session_start"]({}, { cwd: DIR, ui: footerUi });
  t("custom footer installed once", installed === 1 && typeof factory === "function");
  const comp = factory({ requestRender: () => renders++ }, fakeTheme, {});
  const lines: string[] = comp.render(60);
  t("footer renders our state (fallback when pi internals missing)", lines.join("\n").includes("effort"), JSON.stringify(lines));
  t("footer never throws with a shim session", Array.isArray(lines) && lines.length >= 1);

  const before = renders;
  await hooks["before_agent_start"]({ messageType: "user", prompt: "hi" }, { ui: footerUi, cwd: DIR });
  t("footer does not repaint unchanged state", renders === before, `${before} -> ${renders}`);
  const { setEffort: setEffort3 } = await import("./effort.ts");
  setEffort3("low");
  await hooks["before_agent_start"]({ messageType: "user", prompt: "hi" }, { ui: footerUi, cwd: DIR });
  t("footer repaints when effort changes", renders > before, `${before} -> ${renders}`);
  t("footer does not fall back to a second status line", statuses.length === 0, JSON.stringify(statuses));
}

// --- 12e. board colors ------------------------------------------------------
{
  const rendered: string[] = [];
  const fakeTheme = { fg: (token: string, s: string) => `«${token}:${s}»`, bold: (s: string) => `*${s}*` };
  const boardCtx = {
    cwd: DIR,
    ui: {
      notify: () => {},
      custom: (f: any) => {
        const comp = f({ requestRender: () => {} }, fakeTheme, null, () => {});
        rendered.push(...comp.render(120));
      },
    },
  };
  await commands["mykyagent"].handler("", boardCtx);
  const board = rendered.join("\n");
  t("board paints enabled green", board.includes("«success:✓ enabled»"), board.slice(0, 160));
  t("board paints disabled red", board.includes("«error:✗ disabled»"));
  t("board header counts on and off in color", /«success:\d+ on»/.test(board) && /«error:\d+ off»/.test(board));
  t("board marks categories with glyphs", board.includes("⚙") && board.includes("📁"));
}

// --- 12f. merged memory tool ------------------------------------------------
{
  const { getAllToggleableItems } = await import("./toggles.ts");
  t("one memory tool, old names gone", !!tools.memory && !tools.memory_read && !tools.memory_write && !tools.memory_list && !tools.memory_edit);
  t("memory tool is a single board row", getAllToggleableItems([], ["memory"]).filter((i) => i.name === "memory").length === 1);
  t("mcp connection tools fold into the mcp feature row", !getAllToggleableItems([], ["mcp_connect", "mcp_disconnect", "mcp_list"]).some((i) => ["mcp_connect", "mcp_disconnect", "mcp_list"].includes(i.name)));
  const call = (args: any) => tools.memory.execute("x", args);
  const text = (r: any) => String(r?.content?.[0]?.text || "");

  const w = await call({ action: "write", name: "alpha", summary: "alpha summary", body: "alpha body" });
  t("memory write saves a topic", text(w).includes("Saved") && text(w).includes("alpha"));
  t("memory read returns the body", text(await call({ action: "read", name: "alpha" })).includes("alpha body"));
  t("memory list shows the topic", text(await call({ action: "list" })).includes("alpha"));
  t("memory search finds body text", text(await call({ action: "search", query: "alpha body" })).includes("alpha"));
  t("memory edit appends", text(await call({ action: "edit", name: "alpha", body: "more", mode: "append" })).includes("Updated"));
  t("memory rename works", text(await call({ action: "rename", name: "alpha", new_name: "beta" })).includes("beta"));
  t("memory move works", text(await call({ action: "move", name: "beta", target: "global" })).includes("beta"));

  const syn = await call({ action: "save", name: "gamma", summary: "gamma", body: "g" });
  t("memory action synonyms work", text(syn).includes("Saved"));
  t("memory read missing topic errors", (await call({ action: "read", name: "nope" })).isError === true);
  t("memory read without a name errors", (await call({ action: "read" })).isError === true);
  t("memory forget deletes", text(await call({ action: "forget", name: "beta" })).includes("Deleted"));
  t("memory forget missing errors", (await call({ action: "forget", name: "beta" })).isError === true);
  t("memory unknown action falls back to list", text(await call({ action: "zzz" })).includes("gamma"));
}

// --- 12g. /tasks clear ------------------------------------------------------
{
  const notes: string[] = [];
  const tctx = { cwd: DIR, ui: { notify: (m: string) => notes.push(m) } };
  const T = await import("./taskman.ts");
  // One real task, finished immediately; one real task, still alive.
  const doneId = T.startTask("true", "finished-probe");
  for (let i = 0; i < 40 && T.listTasks().find((x) => x.id === doneId)?.running; i++) await new Promise((r) => setTimeout(r, 25));
  const runId = T.startTask("sleep 30", "running-probe");
  const doneDir = join(DIR, "tasks", doneId);

  t("/tasks clear is wired", !!commands["tasks"]);
  await commands["tasks"].handler("clear", tctx);
  t("/tasks clear drops finished only", !existsSync(doneDir) && T.listTasks().some((x) => x.id === runId), notes.at(-1));
  notes.length = 0;
  await commands["tasks"].handler(`clear ${runId}`, tctx);
  t("/tasks clear refuses a running task", notes.at(-1)?.includes("still running") === true, notes.at(-1));
  notes.length = 0;
  await commands["tasks"].handler("clear", tctx);
  t("/tasks clear with nothing finished is calm", notes.at(-1)?.includes("No finished tasks") === true, notes.at(-1));
  T.stopTask(runId);
}

// --- 12h. session brief (/brief, alias /tags) -------------------------------
{
  const { getBrief } = await import("./brief.ts");
  const { isFeatureEnabled: isFeat } = await import("./toggles.ts");
  const notes: string[] = [];
  const bctx = { cwd: DIR, ui: { notify: (m: string) => notes.push(m) } };
  t("/brief registered", !!commands["brief"]);
  t("/tags kept as an alias", !!commands["tags"]);

  await commands["brief"].handler("porting the A155F patch, C only", bctx);
  t("/brief stores and enables", getBrief() === "porting the A155F patch, C only" && isFeat("brief") === true, getBrief());
  const withBrief: string = (await hooks["before_agent_start"]({ messageType: "user", prompt: "hi" }, { cwd: DIR }))?.systemPrompt || "";
  t("brief lands in the prompt", withBrief.includes("porting the A155F patch") && withBrief.includes("Session brief"), withBrief.slice(-200));

  notes.length = 0;
  await commands["tags"].handler("add noir", bctx);
  t("legacy /tags add explains the change", notes.at(-1)!.includes("Tints are gone"), notes.at(-1));
  t("legacy /tags add does not corrupt the brief", getBrief() === "porting the A155F patch, C only");

  notes.length = 0;
  await commands["brief"].handler("clear", bctx);
  t("/brief clear empties it", getBrief() === "" && notes.at(-1)!.includes("cleared"));
  const cleared: string = (await hooks["before_agent_start"]({ messageType: "user", prompt: "hi" }, { cwd: DIR }))?.systemPrompt || "";
  t("cleared brief leaves no trace in the prompt", !cleared.includes("Session brief"));
}

// --- 13. research bundle rendering (helper output contract) ----------------
{
  const { renderResearchBundle } = await import("./index.ts");
  const bundle = renderResearchBundle("q", {
    nav_domain: "artificialanalysis.ai",
    warnings: ["escalated once for missing field(s): price"],
    conflicts: [
      { entity: "GPT-X", values: [{ value: "1.2", sources: ["a.com"] }, { value: "3.4", sources: ["b.com", "c.com"] }] },
    ],
  } as any, { note: "" });
  t("research: nav_domain line rendered", bundle.includes("Source named by the query: artificialanalysis.ai"));
  t("research: warnings block rendered", bundle.includes("RETRIEVAL WARNINGS") && bundle.includes("escalated once for missing field(s): price"));
  t(
    "research: conflict values rendered with sources",
    bundle.includes("GPT-X: 1.2 (a.com)  vs  3.4 (b.com, c.com)"),
    bundle.slice(0, 300)
  );
  const plain = renderResearchBundle("q", { queries_used: ["q"] } as any, {});
  t("research: no nav/warnings/conflicts → no blocks", !plain.includes("RETRIEVAL WARNINGS") && !plain.includes("CONFLICTING SOURCES") && !plain.includes("Source named"));
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

