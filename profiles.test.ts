/**
 * Offline unit tests for profiles: snapshot, switch, auto-save, validation,
 * name resolution, delete/rename, and the /mykyagent badge.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-profiles-"));
const PROFILES = join(DIR, "profiles");
process.env.MYKYAGENT_PROFILES_DIR = PROFILES;
process.env.MYKYAGENT_PROFILE_FILE = join(DIR, "profile.json");
process.env.MYKYAGENT_EFFORT_FILE = join(DIR, "effort.json");
process.env.MYKYAGENT_TOGGLES_FILE = join(DIR, "toggles.json");
process.env.MYKYAGENT_PERSONA_FILE = join(DIR, "persona.json");
process.env.MYKYAGENT_STYLE_FILE = join(DIR, "style.json");
process.env.MYKYAGENT_BRIEF_FILE = join(DIR, "brief.json");

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

const P = await import("./profiles.ts");
P.configureProfiles({ personaFile: () => process.env.MYKYAGENT_PERSONA_FILE! });

const write = (name: string, value: unknown) => writeFileSync(join(DIR, name), JSON.stringify(value, null, 2), "utf-8");
const read = (name: string) => JSON.parse(readFileSync(join(DIR, name), "utf-8"));
const store = (slug: string) => JSON.parse(readFileSync(join(PROFILES, slug, "profile.json"), "utf-8"));

// --- slugs and names --------------------------------------------------------
t("slug from display name", P.slugifyProfileName("Story Night") === "story-night");
t("slug strips punctuation and unicode", P.slugifyProfileName("  Code: max!! ⚡ ") === "code-max");
t("slug cannot escape the config dir", !P.slugifyProfileName("../../etc/passwd").includes("/"));
t("slug is capped", P.slugifyProfileName("x".repeat(80)).length === P.PROFILE_NAME_MAX);
t("empty name rejects", (() => {
  try {
    P.createProfile("   ");
    return false;
  } catch {
    return true;
  }
})());
t("symbol-only name rejects", (() => {
  try {
    P.createProfile("!!!");
    return false;
  } catch {
    return true;
  }
})());

// --- snapshot ----------------------------------------------------------------
write("effort.json", { level: "max" });
write("toggles.json", { features: { effort: true, style: true } });
write("persona.json", { current: "gremlin" });
write("style.json", { mode: "roleplay", tone: "noir" });
write("brief.json", { text: "harbour heist, noir" });

t("no profiles on first run", P.listProfiles().length === 0 && P.getActiveProfile() === null);
t("card explains how to start", P.describeProfiles().includes("/profile new <name>"));
t("badge nudges to create", P.profileBadge().includes("no profiles"));

const a = P.createProfile("Story Night");
t("create returns meta", a.name === "Story Night" && a.slug === "story-night");
t("create snapshots every section", a.sections.join(",") === "effort,persona,style,brief,toggles", a.sections.join(","));
t("snapshot holds the live effort level", a.effort === "max");
t("create activates", P.getActiveProfile() === "story-night");
const storedA = store("story-night");
t("profile file keeps raw store JSON", storedA.settings.toggles.features.effort === true && storedA.settings.brief.text === "harbour heist, noir");
t("profile file has timestamps", !!storedA.created && !!storedA.updated);
t("duplicate name rejects with a hint", (() => {
  try {
    P.createProfile("story night");
    return false;
  } catch (err: any) {
    return err.message.includes("already exists") && err.message.includes("/profile save");
  }
})());

// --- switch + auto-save ------------------------------------------------------
write("effort.json", { level: "low" });
write("persona.json", { current: "caveman" });
const b = P.createProfile("Code Only");
t("second profile activates", P.getActiveProfile() === "code-only" && b.effort === "low");

// Tweak while B is active, then switch back to A: B must keep the tweak.
write("effort.json", { level: "high" });
const res = P.applyProfile("Story Night");
t("switch saves the outgoing profile", res.saved === "Code Only");
t("switch writes the live effort file", read("effort.json").level === "max");
t("switch writes persona, style, brief, toggles", read("persona.json").current === "gremlin" && read("style.json").mode === "roleplay" && read("brief.json").text.includes("harbour") && read("toggles.json").features.style === true);
t("switch marks the new profile active", P.getActiveProfile() === "story-night");
t("outgoing tweaks were persisted", store("code-only").settings.effort.level === "high", JSON.stringify(store("code-only").settings.effort));

// Explicit save overwrites the active profile with the live stores.
write("effort.json", { level: "max" });
write("brief.json", { text: "cozy slice of life" });
const saved = P.saveProfile();
t("save writes the active profile", saved.name === "Story Night" && store("story-night").settings.brief.text === "cozy slice of life");
t("save by name targets another profile", (() => {
  P.saveProfile("Code Only");
  return P.getActiveProfile() === "code-only";
})());

// --- resolution --------------------------------------------------------------
t("resolve by exact slug", P.resolveProfileSlug("story-night") === "story-night");
t("resolve by display name case-insensitively", P.resolveProfileSlug("STORY NIGHT") === "story-night");
t("unknown name resolves to null", P.resolveProfileSlug("nope") === null);

// --- validation --------------------------------------------------------------
const bad = store("story-night");
bad.settings.effort.level = "turbo";
writeFileSync(join(PROFILES, "story-night", "profile.json"), JSON.stringify(bad), "utf-8");
write("effort.json", { level: "low" });
let badErr = "";
try {
  P.applyProfile("story-night");
} catch (err: any) {
  badErr = err.message;
}
t("invalid profile refuses to apply", badErr.includes("invalid") && badErr.includes("turbo"), badErr);
t("refused apply leaves live stores untouched", read("effort.json").level === "low");
t("refused apply leaves the active profile alone", P.getActiveProfile() === "code-only");
t("unknown sections are ignored", P.validateProfileSettings({ mode: { mode: "rp" }, effort: { level: "high" } }).length === 0);
t("non-string style values are rejected", P.validateProfileSettings({ style: { mode: 3 } }).length === 1);

// Corrupt profile file: listed as absent, apply says unreadable.
writeFileSync(join(PROFILES, "story-night", "profile.json"), "{not json", "utf-8");
t("corrupt profile is not listed", !P.listProfiles().some((p) => p.slug === "story-night"));
t("corrupt profile refuses to apply", (() => {
  try {
    P.applyProfile("story-night");
    return false;
  } catch (err: any) {
    return err.message.includes("No profile named") || err.message.includes("unreadable");
  }
})());

// --- delete / rename ---------------------------------------------------------
writeFileSync(join(PROFILES, "story-night", "profile.json"), JSON.stringify(storedA), "utf-8");
const renamed = P.renameProfile("Code Only", "Ship Mode");
t("rename moves the directory", !existsSync(join(PROFILES, "code-only")) && existsSync(join(PROFILES, "ship-mode")));
t("rename keeps the settings", store("ship-mode").settings.brief.text === "cozy slice of life", JSON.stringify(store("ship-mode").settings.brief));
t("rename clears a dotted path", renamed.slug === "ship-mode");
t("rename keeps active pointing at the profile", P.getActiveProfile() === "ship-mode");
t("rename onto an existing slug rejects", (() => {
  try {
    P.renameProfile("Story Night", "Ship Mode");
    return false;
  } catch (err: any) {
    return err.message.includes("already exists");
  }
})());

const del = P.deleteProfile("Ship Mode");
t("delete removes the directory", del.name === "Ship Mode" && !existsSync(join(PROFILES, "ship-mode")));
t("deleting the active profile clears active", P.getActiveProfile() === null);
t("save without an active profile helps", (() => {
  try {
    P.saveProfile();
    return false;
  } catch (err: any) {
    return err.message.includes("/profile use");
  }
})());

// --- empty sections are real settings ---------------------------------------
rmSync(join(DIR, "brief.json"), { force: true });
P.saveProfile("Story Night");
t("missing store is captured as an empty section", JSON.stringify(store("story-night").settings.brief) === "{}", JSON.stringify(store("story-night").settings.brief));
write("brief.json", { text: "added after the snapshot" });
P.applyProfile("Story Night");
t("switch clears settings the profile never had", (await import("./brief.ts")).getBrief() === "", JSON.stringify(read("brief.json")));

// Profiles written before the brief existed still carry a `tags` list.
{
  const legacy = JSON.parse(JSON.stringify(storedA));
  delete legacy.settings.brief;
  legacy.settings.tags = { tags: ["noir", "terse"] };
  writeFileSync(join(PROFILES, "story-night", "profile.json"), JSON.stringify(legacy), "utf-8");
  P.applyProfile("Story Night");
  t("legacy tags become a brief", (await import("./brief.ts")).getBrief() === "noir, terse", JSON.stringify(read("brief.json")));
  t("legacy section is not listed", !P.listProfiles().find((p) => p.slug === "story-night")?.sections.includes("tags"));
}

// --- leftover temp files -----------------------------------------------------
const leftovers = readdirSync(PROFILES).filter((n) => n.includes(".tmp-"));
t("no half-written files left behind", leftovers.length === 0, leftovers.join(","));

// --- unconfigured persona default -------------------------------------------
// configureProfiles is already set; make sure a profile without a persona file
// still applies the rest instead of failing.
writeFileSync(join(PROFILES, "story-night", "profile.json"), JSON.stringify(storedA), "utf-8");
write("effort.json", { level: "low" });
const partial = P.applyProfile("Story Night");
t("apply works when the snapshot is complete", partial.applied.name === "Story Night" && read("effort.json").level === "max");

// --- badge / card ------------------------------------------------------------
const card = P.describeProfiles();
t("card lists profiles and the active one", card.includes("Story Night") && card.includes("active"));
t("badge names the active profile", P.profileBadge().includes("Story Night"));

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
