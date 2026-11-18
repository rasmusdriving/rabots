// The main bot's tools for Pobots' own settings: reading and changing them. Making, changing and retiring bots is in bot-changes.ts.
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import type { ProviderId, ProvidersState, SettingsPatch } from "../../shared/protocol.js";
import { noteChange } from "./notes.js";
import { type ChangeSettingsArgs, ok, problem } from "../team.js";
import type { ToolResult } from "../claude/session.js";
import { writeBotFile } from "../bots.js";
import { EngineError } from "../errors.js";
import { cleanDomains, setInternalDomains } from "./calendar-settings.js";
import { ABOUT_YOU_MAX, aboutYou, setAboutYou } from "./first-start.js";

/** The quiet line a bot's change of settings leaves in its chat: what changed, from what to what (core/notes.ts). */
export function noteChanges(eng: Engine, rt: BotRuntime, changes: string[]): void {
  noteChange(eng, rt, "pobots", "Pobots settings", changes);
}

/** get_settings (main bot): every setting it may change, in plain words with the values to use. */
export function getSettingsFor(eng: Engine): string {
  const v = eng.hub.view();
  const p = eng.hub.providers();
  const kinds = eng.notifier.state().kinds;
  const t = (h: ProviderId) => {
    const x = v.timing[h];
    const set = v.timingSet[h];
    const mark = (k: keyof typeof x) => (set.includes(k) ? "" : " (default)");
    return [
      `enabled ${x.enabled}${mark("enabled")}`,
      `minTokens ${x.minTokens}${mark("minTokens")}`,
      `fullFraction ${x.fullFraction}${mark("fullFraction")}`,
      `fullTokens ${x.fullTokens}${mark("fullTokens")}`,
      ...(h === "claude" ? [`warmMarginMinutes ${x.warmMarginMinutes}${mark("warmMarginMinutes")}`] : []),
      `coldHours ${x.coldHours}${mark("coldHours")}`,
      `compactTokens ${x.compactTokens}${mark("compactTokens")}`,
    ].join(", ");
  };
  const bots = eng.order.map((id) => eng.bots.get(id)!).map((b) => `${b.folder.file.name} (id ${b.folder.id}): ${b.folder.file.followUp ?? "default"}`);
  const prov = p.providers.map(
    (x) => `- ${x.label} (${x.id}): ${x.enabled ? "on" : "off"}, ${x.ready ? "ready" : "not ready"}, version ${x.version ?? "unknown"}${x.latest ? `, newest ${x.latest}` : ""}${x.updateAvailable ? ", an update is available (run_pobots_task update_providers)" : ""}.`,
  );
  const listed = (h: "claude" | "codex") => eng.modelList().filter((m) => m.harness === h).map((m) => `${m.id} (${m.label})`);
  const claudeModels = listed("claude");
  const gptModels = listed("codex");
  return [
    `Message sent while a bot works (follow_up_default): ${eng.chat.followUp}. Each bot's own choice (bot_follow_up): ${bots.join("; ")}.`,
    `Fresh starts (chats), Claude bots: ${t("claude")}.`,
    `Fresh starts (chats), Codex bots: ${t("codex")}.`,
    `Pobots looks at the providers every ${v.healthCheckSeconds} seconds (health_check_seconds, 0 is never).`,
    `Providers:\n${prov.join("\n")}`,
    pobotsLine(eng.engineVersion, p.pobots),
    `Chat titles are made by ${v.titleModel} (title_model). Claude models: ${claudeModels.join(", ") || "none"}. GPT models, through Codex: ${gptModels.join(", ") || "none"}.`,
    `Notifications: needs ${kinds.needs}, note ${kinds.note}, finished ${kinds.finished}.`,
    aboutYouLine(eng),
    `Usage hubs: ${v.hubs.length ? v.hubs.map((h) => h.url).join(", ") : "none"} (added and removed by the person in the app only).`,
  ].join("\n");
}

/** Pobots's own version for get_settings; on a public install also whether a newer one is there (engine 0.34.0). */
function pobotsLine(version: string, s: ProvidersState["pobots"]): string {
  if (!s) return `Pobots: version ${version}. It is updated another way here, not with run_pobots_task.`;
  const run = s.run ? ` ${s.run.endedAt ? "Last update" : "Updating now"}: ${s.run.line}` : "";
  const state = s.available ? `Pobots ${s.latest} is available${s.canRestart ? " (run_pobots_task update_pobots asks the person on a card)" : ", but this Pobots cannot restart itself, so the person updates it by hand"}.` : s.checkedAt ? "Up to date." : "Not looked for a newer version yet (get_settings fresh looks).";
  return `Pobots: version ${s.current}. ${state}${s.problem ? ` ${s.problem}` : ""}${run}`;
}

/** About you for get_settings: the text itself, since the main bot keeps it up to date. */
function aboutYouLine(eng: Engine): string {
  const text = aboutYou(eng);
  return text ? `About you (about_you), the note every bot gets:\n${text}` : "About you (about_you): not written yet.";
}

/** change_settings (main bot): no card; a quiet line in its chat tells the person what changed (decided 14 Nov 2026). */
export function changeSettingsFor(eng: Engine, rt: BotRuntime, args: ChangeSettingsArgs): ToolResult {
  const changes: string[] = [];
  try {
    // Checked first, so a bad part changes nothing.
    const target = args.bot_follow_up ? eng.findBot(args.bot_follow_up.bot) : undefined;
    if (args.bot_follow_up && !target) return problem("There is no bot with that name or id.");
    const patch: SettingsPatch = {};
    if (args.about_you !== undefined && args.about_you.trim().length > ABOUT_YOU_MAX) return problem(`About you is too long. Keep it under ${ABOUT_YOU_MAX.toLocaleString("en-US")} characters.`);
    if (args.chats) {
      const which: ProviderId[] = args.chats.provider === "both" ? ["claude", "codex"] : [args.chats.provider];
      const values: Record<string, number | boolean | null> = {};
      for (const k of ["enabled", "minTokens", "fullFraction", "fullTokens", "warmMarginMinutes", "coldHours", "compactTokens"] as const) if (args.chats[k] !== undefined) values[k] = args.chats[k]!;
      for (const k of args.chats.reset ?? []) values[k] = null;
      patch.timing = Object.fromEntries(which.map((h) => [h, values]));
    }
    if (args.health_check_seconds !== undefined) patch.healthCheckSeconds = args.health_check_seconds;
    if (args.title_model !== undefined) patch.titleModel = args.title_model;
    if (args.providers) patch.providers = Object.fromEntries(Object.entries(args.providers).filter(([, on]) => on !== undefined).map(([h, on]) => [h, { enabled: on as boolean }]));
    // Checked before anything changes, so a bad domain changes nothing.
    if (args.calendar_internal_domains !== undefined) cleanDomains(args.calendar_internal_domains);
    if (Object.keys(patch).length) changes.push(...eng.hub.set(patch).changes);
    if (args.calendar_internal_domains !== undefined) {
      const line = setInternalDomains(eng, args.calendar_internal_domains);
      if (line) changes.push(line);
    }
    if (patch.providers && changes.some((c) => / switched (on|off)$/.test(c))) eng.opts.emit("status.updated", { status: eng.status(), models: eng.modelList() });
    if (args.follow_up_default && args.follow_up_default !== eng.chat.followUp) {
      const was = eng.chat.followUp;
      eng.chatSet({ followUp: args.follow_up_default });
      changes.push(`a message sent while a bot works: ${args.follow_up_default} (was ${was})`);
    }
    if (target && args.bot_follow_up) {
      const f = target.folder.file;
      const was = f.followUp ?? "the Pobots default";
      const next = args.bot_follow_up.choice === "default" ? undefined : args.bot_follow_up.choice;
      if (next !== f.followUp) {
        if (next) f.followUp = next;
        else delete f.followUp;
        writeBotFile(target.folder.dir, f);
        eng.opts.emit("bot.updated", { bot: eng.toBot(target) });
        changes.push(`${f.name}, a message sent while it works: ${next ?? "the Pobots default"} (was ${was})`);
      }
    }
    if (args.about_you !== undefined) {
      const line = setAboutYou(eng, args.about_you);
      if (line) changes.push(line);
    }
    if (args.notifications) {
      const before = eng.notifier.state().kinds;
      const kinds = Object.fromEntries(Object.entries(args.notifications).filter(([, on]) => on !== undefined)) as Partial<Record<"needs" | "note" | "finished", boolean>>;
      eng.notifier.setKinds(kinds);
      for (const [k, on] of Object.entries(kinds)) if (before[k as keyof typeof before] !== on) changes.push(`notifications for ${k} ${on ? "on" : "off"} (was ${on ? "off" : "on"})`);
    }
  } catch (err) {
    if (changes.length) noteChanges(eng, rt, changes);
    const why = err instanceof EngineError ? err.message : "The settings could not be changed.";
    return problem(changes.length ? `${why} These changed before that: ${changes.join("; ")}.` : why);
  }
  if (!changes.length) return ok("Nothing changed: the settings already had those values.");
  noteChanges(eng, rt, changes);
  return ok(`Changed, and the person has a note about it:\n- ${changes.join("\n- ")}`);
}

/** Bot ids from ids or names. An unknown one is refused in plain words. */
export function resolveBotRefs(eng: Engine, refs: string[]): string[] {
  const out: string[] = [];
  for (const ref of refs) {
    const b = eng.findBot(ref);
    if (!b) throw new Error(`There is no bot called ${ref}. Use list_bots to see the others.`);
    if (!out.includes(b.folder.id)) out.push(b.folder.id);
  }
  return out;
}
