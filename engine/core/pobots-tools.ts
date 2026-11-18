// Pobots as a whole, for the main bot (docs/main-bot.md): get_settings with the backup, the
// notification devices and the usage meters, and run_pobots_task (back up now, update the providers,
// update Pobots itself on a public install behind a card (engine 0.34.0), a test notification). The backup key, usage hubs and turning notifications on for a device stay with
// the person: none of them is reachable here, and no key, address or token is ever told.
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import type { ToolResult } from "../claude/session.js";
import { ok, problem, type PobotsTaskArgs } from "../team.js";
import { EngineError } from "../errors.js";
import { getSettingsFor } from "./main-bot-tools.js";
import { calendarSettingsWords } from "./calendar-settings.js";
import { noteChange } from "./notes.js";
import { approval } from "./cards.js";
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
  return [head, getSettingsFor(eng), backupWords(eng), devicesWords(eng), usageWords(eng), calendarSettingsWords(eng)].join("\n");
}

function backupWords(eng: Engine): string {
  const b = eng.backup.state();
  const last = b.lastGood ? `Last good ${localWhen(eng, b.lastGood.at)} (${b.lastGood.status}${b.lastGood.by === "you" ? ", by hand" : ""})` : "No good one yet";
  const latest = b.history[0];
  const failed = latest && latest.status === "failed" ? ` The newest run failed: ${latest.problem ?? "no reason given"}.` : "";
  return [
    `Backup: ${b.key ? `key set (${b.key.fingerprint})` : "no key set, so no backup runs (the person sets the key in the app)"}.`,
    `Folder ${b.folder.ok ? "ok" : `not usable: ${b.folder.problem ?? "unknown"}`}. Every night at ${b.time}, ${b.keep} nights kept.`,
    `${b.running ? "Running now. " : ""}${b.nextAt ? `Next ${localWhen(eng, b.nextAt)}. ` : ""}${last}.${failed}`,
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
  const lines = u.providers.flatMap((p) =>
    p.accounts.map((a) => `- ${p.label}${a.plan ? `, ${a.plan}` : ""}, via ${a.via}: ${a.problem ?? (a.windows.map((w) => `${w.label} ${Math.round(w.usedPercent)}% used${w.resetsAt ? `, resets ${localWhen(eng, w.resetsAt)}` : ""}`).join("; ") || "no meters")}`),
  );
  return `Usage${u.checkedAt ? ` (read ${localWhen(eng, u.checkedAt)})` : ""}:\n${lines.join("\n")}`;
}

/** The note that wakes the bot that started Pobots's own update, once it has ended (also after the restart). */
export function updateAskerNote(line: string, version: string, ok: boolean): string {
  return [
    `Note from Pobots: the update of Pobots that the person allowed has ended. ${line} Pobots now runs version ${version}.`,
    ok ? "Tell the person in one short sentence that Pobots is updated and which version runs now." : "Tell the person in one or two short sentences that the update did not go through, which version runs now, and the reason in plain words.",
    "Use no tools.",
  ].join(" ");
}

/** Wakes that bot (the main bot when it is gone) in its main chat. */
export function tellUpdateAsker(eng: Engine, botId: string, line: string, version: string, ok: boolean): void {
  const rt = eng.bots.get(botId) ?? [...eng.bots.values()].find((b) => b.folder.file.role === "main");
  if (!rt) return;
  log.info(`Bot ${rt.folder.id}: told how the update of Pobots went`);
  wake(eng, rt, { text: updateAskerNote(line, version, ok), purpose: { startedBy: "you", threadId: rt.threadId, fresh: false, hops: 0 } });
}

/** run_pobots_task: one thing for Pobots now. */
export async function runPobotsTaskFor(eng: Engine, rt: BotRuntime, args: PobotsTaskArgs, signal?: AbortSignal): Promise<ToolResult> {
  try {
    switch (args.task) {
      case "back_up_now": {
        if (!eng.backup.state().key) return problem("No backup key is set, so nothing can be backed up. The person sets the key in the app (Settings, General, Backup); that stays with them.");
        const b = eng.runBackup().backup;
        noteChange(eng, rt, "pobots", "Pobots", ["started a backup of every chat, every bot's folder and the settings"]);
        return ok(`${b.running ? "A backup is being made now." : "The backup was started."} If it fails the person gets a card; get_settings shows how it went.`);
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
            detail: [`Pobots ${s.current} to ${s.latest}.`, "", "It waits until every bot is calm, then restarts. The window reconnects by itself after about a minute.", "", `Asked by ${rt.folder.file.name}.`].join("\n"),
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
