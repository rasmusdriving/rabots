// Pobots as a whole, for the main bot (docs/main-bot.md): get_settings with the backup, the
// notification devices and the usage meters, and run_pobots_task (back up now, update the providers,
// update Pobots itself on a public install behind a card (engine 0.34.0), a test notification). The backup password reference, usage hubs and turning notifications on for a device stay with
// the person: none of them is reachable here, and no key, address or token is ever told.
import { aheadSettingsWords } from "./ahead-settings.js";
import { usageCreditRows } from "../../shared/usage-credits.js";
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import type { ToolResult } from "../claude/session.js";
import { ok, problem, type PobotsTaskArgs } from "../team.js";
import { EngineError } from "../errors.js";
import { getSettingsFor } from "./main-bot-tools.js";
import { calendarSettingsWords } from "./calendar-settings.js";
import { holdNotice, noteChange } from "./notes.js";
import { approval, showSystemCard } from "./cards.js";
import { notesWords } from "./changelog.js";
import type { ReleaseNote } from "../../shared/protocol.js";
import { refused } from "./words.js";
import { wake } from "./start-helper.js";
import { log } from "../log.js";
import { localWhen } from "./words.js";
import { usageHistoryWords, type UsageToolArgs } from "./usage-history/tool.js";
import { nowWords } from "../schedule.js";

/** get_settings: Pobots' settings, then the backup, the devices and the usage. `fresh` looks again first. */
export async function getSettingsFresh(eng: Engine, args: UsageToolArgs): Promise<string> {
  if (args.usage_range) return usageHistoryWords(eng, { ...args, usage_range: args.usage_range });
  if (args.fresh) {
    await Promise.allSettled([eng.providersCheck(), eng.usageRead({ refresh: true })]).then((rs) => {
      for (const r of rs) if (r.status === "rejected") log.warn("get_settings: a fresh look failed", r.reason);
    });
  }
  // Every time below is on the engine's clock, in its time zone, like the trigger tools' words.
  const head = `It is now ${nowWords(eng.clock(), eng.tz)} (time zone ${eng.tz}); the times below are in that zone.`;
  return [head, getSettingsFor(eng), backupWords(eng), devicesWords(eng), usageWords(eng), calendarSettingsWords(eng), aheadSettingsWords(eng)].join("\n");
}

function backupWords(eng: Engine): string {
  const b = eng.backup.state();
  const latest = b.history[0];
  const last = latest
    ? `Last run ${localWhen(eng, latest.at)}: ${latest.status === "saved" ? "saved to iCloud" : latest.status}${latest.bytes === undefined ? "" : `, ${latest.bytes} bytes added`}.${latest.problem ? ` ${latest.problem}` : ""}`
    : "No backups yet.";
  return [
    `Backup: ${b.resticInstalled ? "restic installed" : "Install restic: brew install restic"}. ${b.passwordRef ? "1Password reference set" : "Add a 1Password reference in Settings, General, Backup"}.`,
    `${b.folder.iCloud ? "iCloud Drive" : "Local folder"}: ${b.folder.path || "not set"}.${b.folder.problem ? ` ${b.folder.problem}` : ""}`,
    `Every night at ${b.time}, ${b.keep} nightly snapshots kept. ${b.snapshots ?? 0} in the repository${b.repositoryBytes === undefined ? "" : `, ${b.repositoryBytes} bytes total`}.`,
    `${b.running ? "Running now. " : ""}${b.nextAt ? `Next ${localWhen(eng, b.nextAt)}. ` : ""}${last}`,
  ].join(" ");
}

function devicesWords(eng: Engine): string {
  const devices = eng.notifier.state().devices;
  if (!devices.length) return "Notification devices: none. The person turns notifications on in the app, on each device.";
  return `Notification devices (turned on and forgotten by the person on each device):\n${devices
    .map((d) => `- ${d.label} (id ${d.id}, ${d.service})${d.goneAt ? ", no longer takes notifications" : ""}${d.last ? `, last ${d.last.kind} ${localWhen(eng, d.last.at)}: ${d.last.result}` : ""}`)
    .join("\n")}`;
}

function usageWords(eng: Engine): string {
  const u = eng.hub.usageState();
  if (!u.providers.length) return `Usage: ${u.problem ?? "not read yet"} (get_settings fresh reads it).`;
  const lines = u.providers.flatMap((p) => p.accounts.map((a) => {
    const windows = a.windows.map((w) => {
      const figure = p.id === "codex" ? `${w.label}: ${Math.round(100 - w.usedPercent)}% left` : `${w.label} ${Math.round(w.usedPercent)}% used`;
      return `${figure}${w.resetsAt ? `, resets ${localWhen(eng, w.resetsAt)}` : ""}`;
    });
    const credits = usageCreditRows(a).map((row) =>
      `${row.label}: ${row.value}${row.expiresAt ? `, ${row.id === "reset" ? "next " : ""}expires ${localWhen(eng, row.expiresAt)}` : ""}${row.resetsAt ? `, resets ${localWhen(eng, row.resetsAt)}` : ""}`,
    );
    const meters = [...windows, ...credits, ...(a.problem ? [a.problem] : [])];
    return `- ${p.label}${a.plan ? `, ${a.plan}` : ""}, via ${a.via}: ${meters.join("; ") || "no meters"}`;
  }));
  if (u.problem) lines.push(u.problem);
  return `Usage${u.checkedAt ? ` (read ${localWhen(eng, u.checkedAt)})` : ""}:\n${lines.join("\n")}`;
}

/** The note that wakes the bot that started Pobots's own update, once it has ended (also after the restart). */
export function updateAskerNote(line: string, version: string, ok: boolean, notes?: ReleaseNote[]): string {
  const news = ok ? notesWords(notes) : [];
  return [
    `Note from Pobots: the update of Pobots that the person allowed has ended. ${line} Pobots now runs version ${version}.`,
    ...(news.length ? [`What is new, from Pobots's changelog:\n${news.join("\n")}\n`] : []),
    ok
      ? news.length
        ? "Tell the person in one short sentence that Pobots is updated and which version runs now, then in a sentence or two what is new, in your own plain words."
        : "Tell the person in one short sentence that Pobots is updated and which version runs now."
      : "Tell the person in one or two short sentences that the update did not go through, which version runs now, and the reason in plain words.",
    "Use no tools.",
  ].join(" ");
}

/** The quiet line that stands right before that turn in the chat, so it does not show as a helper reporting back. */
export function updateTurnLine(version: string, ok: boolean): string {
  return ok ? `Pobots is updated to ${version}.` : "The update of Pobots did not go through.";
}

/** Wakes that bot (the main bot when it is gone) in its main chat. */
export function tellUpdateAsker(eng: Engine, botId: string, line: string, version: string, ok: boolean, notes?: ReleaseNote[]): void {
  const rt = eng.bots.get(botId) ?? [...eng.bots.values()].find((b) => b.folder.file.role === "main");
  if (!rt) return;
  log.info(`Bot ${rt.folder.id}: told how the update of Pobots went`);
  holdNotice(eng, rt, { text: updateTurnLine(version, ok), tone: "info", startsTurn: true });
  wake(eng, rt, { text: updateAskerNote(line, version, ok, notes), purpose: { startedBy: "you", threadId: rt.threadId, fresh: false, hops: 0 } });
}

/**
 * Pobots's own card on the rail, once after an update (protocol 36): "Pobots is updated to 0.45.0"
 * with what is new since the version before. It stays until the person dismisses it.
 */
export function showUpdatedCard(eng: Engine, from: string | undefined, to: string, notes: ReleaseNote[]): void {
  const text = notes.length ? "" : from ? `It was ${from} before.` : "";
  showSystemCard(eng, "update", `Pobots is updated to ${to}`, text, notes);
  log.info(`Pobots ${to}: the card about the update is up${notes.length ? ` with the notes of ${notes.map((n) => n.version).join(", ")}` : ""}`);
}

/** run_pobots_task: one thing for Pobots now. */
export async function runPobotsTaskFor(eng: Engine, rt: BotRuntime, args: PobotsTaskArgs, signal?: AbortSignal): Promise<ToolResult> {
  try {
    switch (args.task) {
      case "back_up_now": {
        const state = eng.backup.state();
        if (!state.resticInstalled) return problem("Install restic: brew install restic");
        if (!state.passwordRef) return problem("No backup password reference is set. The person adds it in Settings, General, Backup.");
        const b = eng.runBackup().backup;
        noteChange(eng, rt, "pobots", "Pobots", ["started a backup of every chat, every bot's folder and the settings"]);
        return ok(`${b.running ? "A backup is being made now." : "The backup was started."} get_settings shows how it went.`);
      }
      case "update_providers": {
        const p = (await eng.providersUpdate({ providers: true })).providers;
        const todo = p.providers.filter((x) => x.updateAvailable).map((x) => `${x.label} ${x.version ?? "?"} to ${x.latest ?? "the newest"}`);
        noteChange(eng, rt, "pobots", "Pobots", [`started an update of ${todo.join(" and ") || "Claude Code and Codex"}, once every bot is calm`]);
        return ok(`The update has started: ${p.update?.line ?? "it waits until every bot is calm"} It goes on after your turn ends. get_settings shows how it went.`);
      }
      case "update_pobots": {
        const s = eng.hub.providers().pobots;
        if (!s) return problem("This Pobots updates another way: it does not run from a copy of the public repository, so there is nothing to update here.");
        if (s.run && !s.run.endedAt) return ok(`An update of Pobots is already running: ${s.run.line}`);
        if (!s.available || !s.latest) return ok(`Pobots is up to date (${s.current}).${s.checkedAt ? "" : " It has not looked yet; get_settings fresh looks now."}`);
        // Asked before the card, so the person is never asked for something that cannot run.
        const no = await eng.hub.pobotsRefusal();
        if (no) return problem(no);
        const decision = await approval(
          eng,
          rt,
          {
            title: `Update Pobots to ${s.latest}?`,
            detail: [`Pobots ${s.current} to ${s.latest}.`, ...whatsNewDetail(s.whatsNew), "", "It waits until every bot is calm, then restarts. The window reconnects by itself after about a minute.", "", `Asked by ${rt.folder.file.name}.`].join("\n"),
            caption: "Update",
          },
          signal,
        );
        if (decision !== "allow") return refused(decision, "Pobots was not updated");
        await eng.providersUpdate({ pobots: true, askedBy: rt.folder.id });
        noteChange(eng, rt, "pobots", "Pobots", [`started the update to ${s.latest}, as you allowed; Pobots restarts once every bot is calm`]);
        return ok(`The person allowed it. The update to ${s.latest} has started; Pobots restarts once every bot is calm, so after your turn. Tell the person in a sentence that Pobots will restart and come back by itself in about a minute. When it is done, Pobots wakes you with how it went, and you tell them which version runs.`);
      }
      case "test_notification": {
        const devices = eng.notifier.state().devices.filter((d) => !d.goneAt);
        if (!devices.length) return problem("No device takes notifications. The person turns them on in the app, on that device.");
        const want = args.device?.trim().toLowerCase();
        const device = want ? devices.find((d) => d.id.toLowerCase() === want || d.label.toLowerCase() === want) : devices.length === 1 ? devices[0] : undefined;
        if (!device) return problem(`Say which device: ${devices.map((d) => `${d.label} (id ${d.id})`).join(", ")}.`);
        const after = (await eng.notifyTest(device.id)).notify.devices.find((d) => d.id === device.id);
        const r = after?.last;
        return ok(r ? `Sent a test to ${device.label}: ${r.result}${r.problem ? ` (${r.problem})` : ""}.` : `Sent a test to ${device.label}.`);
      }
    }
  } catch (err) {
    return problem(err instanceof EngineError ? err.message : "That could not be done.");
  }
  return problem("Unknown task.");
}

/** "What's new" on the update_pobots card: up to five bullets, newest first, with how many more there are. */
function whatsNewDetail(notes: ReleaseNote[] | undefined): string[] {
  if (!notes?.length) return [];
  const all = notes.flatMap((n) => n.items);
  const total = notes.reduce((sum, n) => sum + n.totalItems, 0);
  const shown = all.slice(0, 5);
  return ["", "What's new:", ...shown.map((t) => `- ${t}`), ...(total > shown.length ? [`And ${total - shown.length} more.`] : [])];
}
