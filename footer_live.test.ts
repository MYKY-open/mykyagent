/**
 * Regression: the extension footer must follow the live thinking level and
 * model. The footer is built once and kept, so it must read pi's ctx through
 * getters instead of copying values at build time (that froze "thinking off"
 * after /thinking). Offline: no pi runtime, no network.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-footer-"));
for (const [k, f] of Object.entries({
  MYKYAGENT_TOGGLES_FILE: "toggles.json",
  MYKYAGENT_MODE_FILE: "mode.json",
  MYKYAGENT_EFFORT_FILE: "effort.json",
  MYKYAGENT_PROFILES_DIR: "profiles",
  MYKYAGENT_PROFILE_FILE: "profile.json",
  MYKYAGENT_MCP_FILE: "mcp.json",
  MYKYAGENT_MCPKILL_FILE: "mcpkill.json",
  MYKYAGENT_WEBKILL_FILE: "webkill.json",
  MYKYAGENT_WEBBROWSER_FILE: "webbrowser.json",
  MYKYAGENT_STYLE_FILE: "style.json",
  MYKYAGENT_BRIEF_FILE: "brief.json",
  MYKYAGENT_MEMORY_DIR: "memory",
  MYKYAGENT_TASKS_DIR: "tasks",
})) process.env[k] = join(DIR, f);

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

const pkg: any = await import("@earendil-works/pi-coding-agent");
pkg.initTheme?.(); // FooterComponent reads the theme; pi calls this at startup
const ext = (await import("./index.ts")).default;

const hooks: Record<string, any> = {};
await ext({
  on: (n: string, f: any) => (hooks[n] = f),
  sendUserMessage: () => {},
  registerTool: () => {},
  registerCommand: () => {},
  getActiveTools: () => [],
  getAllTools: () => [],
  setActiveTools: () => {},
});

// Live ctx: pi's real ctx exposes model/thinkingLevel as getters over the session.
const live: any = { thinkingLevel: "off", model: { id: "probe-model", provider: "probe", reasoning: true } };
let factory: any = null;
const ui = { notify: () => {}, setStatus: () => {}, setFooter: (f: any) => (factory = f), requestRender: () => {} };
const sessionManager = {
  getEntryCount: () => 0,
  getSessionId: () => "s",
  getLeafId: () => null,
  getEntries: () => [],
  getCwd: () => DIR,
  getSessionName: () => undefined,
};
const footerData = {
  getGitBranch: () => null,
  getAvailableProviderCount: () => 1,
  getExtensionStatuses: () => new Map(),
  onBranchChange: () => () => {},
};
const theme = { fg: (_t: string, s: string) => s, bold: (s: string) => s };
// `stale` mimics pi's assertActive(): once the session is replaced, ctx reads throw.
let stale = false;
const ctx = new Proxy({ cwd: DIR, ui, sessionManager, getContextUsage: () => undefined }, {
  get: (o: any, k: any) => {
    if (stale && (k === "model" || k === "thinkingLevel")) throw new Error("This extension ctx is stale");
    return k in live ? live[k] : o[k];
  },
});
await hooks["session_start"]({}, ctx);
t("custom footer installed", typeof factory === "function");

const comp = factory({ requestRender: () => {} }, theme, footerData);
const render = () => comp.render(160).join("\n");

const start = render();
t("starts at thinking off", start.includes("thinking off"), JSON.stringify(start.slice(-80)));

// What pi's cycleThinkingLevel does: change the level, then invalidate.
live.thinkingLevel = "high";
comp.invalidate?.();
const afterLevel = render();
t("footer follows /thinking level change", afterLevel.includes("probe-model • high"), JSON.stringify(afterLevel.slice(-80)));

live.thinkingLevel = "medium";
live.model = { id: "other-model", provider: "probe", reasoning: true };
comp.invalidate?.();
const afterModel = render();
t("footer follows model switch", afterModel.includes("other-model • medium"), JSON.stringify(afterModel.slice(-80)));

// A stale ctx (pi throws from assertActive) must degrade, never crash the footer.
stale = true;
let staleOk = true;
try {
  staleOk = render().length > 0;
} catch {
  staleOk = false;
}
t("stale ctx does not throw from render", staleOk);
stale = false;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
