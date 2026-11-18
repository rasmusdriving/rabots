// The mock engine's triggers: schedules and webhooks, what is coming up, a run and a fresh run.
// Free functions of the mock: `mock` is the MockEngine, and each keeps a one-line method there. Moved
// out of mock.ts unchanged on 15 Nov 2026 (docs/build/step-split.md).
import type { ActivityItem, BotItem, Methods, Schedule, Trigger, TriggerRun, Upcoming, UserItem } from "../../shared/protocol";
import { nextRun, scheduleProblem } from "../lib/schedule";
import { EngineError } from "./types";
import {
  BRIEF,
  BRIEF_PROMPT,
  PROMISE_PROMPT,
  TEAMS_PROMPT,
  TICKET_PROMPT,
  TICKET_RESULT,
  TRIGGER_ANSWER,
  hookText,
  NOTHING,
  at,
  today,
  minutesAgo,
  later,
  type Turn,
  type MockTrigger,
  secret,
  firstWords,
  publicTrigger,
  WORK_DAYS_LIST,
} from "./mock-data";
import type { MockEngine } from "./mock";

export function seedTriggers(mock: MockEngine): void {
  const all = [...WORK_DAYS_LIST];
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  const mk = (t: Omit<MockTrigger, "id" | "enabled" | "createdBy" | "nextAt" | "lastRun"> & Partial<MockTrigger>): MockTrigger => {
    const trig: MockTrigger = { id: `tr${mock.nextId++}`, enabled: true, createdBy: "you", ...t };
    if (trig.kind === "webhook") trig.secret = secret();
    mock.triggers.push(trig);
    mock.runs.set(trig.id, []);
    return trig;
  };
  const run = (t: MockTrigger, when: string, status: TriggerRun["status"], extra: Partial<TriggerRun> = {}) => {
    const r: TriggerRun = { id: `run${mock.nextId++}`, triggerId: t.id, botId: t.botId, at: when, status, ...extra };
    const list = mock.runs.get(t.id)!;
    list.push(r);
    list.sort((a, b) => b.at.localeCompare(a.at));
    t.lastRun = list[0];
    return r;
  };
  /** A fresh run's own thread: the prompt, a line of work and the answer. */
  const freshThread = (botId: string, label: string, prompt: string, work: string, answer: string, time: string): string => {
    const threadId = `run-${mock.nextId++}`;
    mock.threads.set(threadId, []);
    const turnId = `turn${mock.nextId++}`;
    const later1 = new Date(new Date(time).getTime() + 40_000).toISOString();
    mock.add<UserItem>(threadId, { kind: "user", from: { type: "trigger", label }, queued: false, turnId, text: prompt }, time);
    mock.add<ActivityItem>(threadId, { kind: "activity", botId, turnId, label: work, status: "done", durationMs: 31_000 }, time);
    mock.add<BotItem>(threadId, { kind: "bot", botId, turnId, streaming: false, text: answer }, later1);
    return threadId;
  };

  // Kaja: a fresh morning brief on weekdays, a quiet midday sweep, a promise sweep in its chat.
  const brief = mk({ botId: "kaja", kind: "schedule", name: "Morning brief", prompt: BRIEF_PROMPT, where: "fresh", schedule: { type: "daily", time: "07:30", days: all } });
  run(brief, at(4, 7, 30), "failed", { note: "I could not reach the calendar. I will try again at the next run." });
  run(brief, at(3, 7, 30), "skipped", { note: "Pobots was not running at 07:30" });
  run(brief, at(2, 7, 30), "done", { note: "Good morning. One meeting today, at 14:00. Nothing needs you yet.", threadId: freshThread("kaja", "Morning brief", BRIEF_PROMPT, "Read today's calendar", "Good morning. One meeting today, at 14:00. Nothing needs you yet.", at(2, 7, 30)) });
  run(brief, at(1, 7, 30), "done", { note: "Good morning. Three onboardings are open and the Nordvik import is on Thursday.", threadId: freshThread("kaja", "Morning brief", BRIEF_PROMPT, "Read today's calendar", "Good morning. Three onboardings are open and the Nordvik import is on Thursday.", at(1, 7, 30)) });
  const briefThread = freshThread("kaja", "Morning brief", BRIEF_PROMPT, "Read 14 new messages in Teams", BRIEF, today(7, 30));
  run(brief, today(7, 30), "done", { note: firstWords(BRIEF), threadId: briefThread });

  const sweep = mk({ botId: "kaja", kind: "schedule", name: "Midday sweep", prompt: "Look for anything new that needs the person. Only report if there is something.", where: "fresh", quiet: true, schedule: { type: "every", minutes: 60, days: all, from: "11:00", to: "14:00" } });
  for (const h of [11, 12, 13, 14]) run(sweep, at(1, h, 0), "silent", { note: NOTHING, threadId: freshThread("kaja", "Midday sweep", sweep.prompt, "Read new messages", NOTHING, at(1, h, 0)) });

  const promise = mk({ botId: "kaja", kind: "schedule", name: "Promise sweep", prompt: PROMISE_PROMPT, where: "main", schedule: { type: "daily", time: "16:30", days: [...days] } });
  run(promise, at(2, 16, 30), "skipped", { note: "The last run was still going" });
  run(promise, at(1, 16, 30), "done", { note: "Two promises are still open: the Nordvik import date and the report template for Aalto.", threadId: "kaja-main", turnId: "tk-ps" });

  // Inbox: a webhook from Teams that is running now, and a quiet mail check it set up itself.
  const teams = mk({ botId: "inbox", kind: "webhook", name: "New Teams message", prompt: TEAMS_PROMPT, where: "main" });
  run(teams, at(1, 15, 2), "done", { note: "Nothing for the person. Lina said thanks for the agenda.", threadId: "inbox-main" });
  run(teams, at(1, 15, 3), "skipped", { note: "The last run was still going" });
  run(teams, today(9, 5), "done", { note: "Nordvik asks when the import runs. I told Kaja.", threadId: "inbox-main" });
  run(teams, minutesAgo(1), "running", { threadId: "inbox-main", turnId: "ti3" });

  const mail = mk({ botId: "inbox", kind: "schedule", name: "Check mail", prompt: "Read new mail. Only report if something needs the person.", where: "fresh", quiet: true, createdBy: "bot", schedule: { type: "every", minutes: 15, days: all, from: "07:00", to: "18:00" } });
  for (const m of [45, 30, 15]) run(mail, minutesAgo(m), "silent", { note: NOTHING, threadId: freshThread("inbox", "Check mail", mail.prompt, "Read 3 new mails", NOTHING, minutesAgo(m)) });

  // HubSpot tickets: a webhook whose last run failed.
  const ticket = mk({ botId: "hubspot-tickets", kind: "webhook", name: "New ticket", prompt: TICKET_PROMPT, where: "fresh" });
  run(ticket, at(1, 14, 5), "done", { note: firstWords(TICKET_RESULT), threadId: freshThread("hubspot-tickets", "New ticket", hookText(TICKET_PROMPT, { ticket: 48213, customer: "Aalto", subject: "Report template" }), "Read ticket 48213 in HubSpot", TICKET_RESULT, at(1, 14, 5)) });
  run(ticket, minutesAgo(25), "failed", { note: "I could not reach HubSpot. I will try again on the next call.", threadId: freshThread("hubspot-tickets", "New ticket", hookText(TICKET_PROMPT, { ticket: 48230, customer: "Nordvik", subject: "Import" }), "Tried to read ticket 48230", "I could not reach HubSpot. I will try again on the next call.", minutesAgo(25)) });

  // Onboardings: a morning check in its chat, and a report once on Friday.
  const check = mk({ botId: "onboardings", kind: "schedule", name: "Morning check", prompt: "Check the open onboardings.", where: "main", schedule: { type: "daily", time: "08:00", days: [...days] } });
  run(check, today(8, 0), "done", { note: "Three onboardings are open. Nordvik imports on Thursday.", threadId: "onboardings-main", turnId: "to1" });
  const friday = new Date();
  friday.setDate(friday.getDate() + ((5 - friday.getDay() + 7) % 7));
  friday.setHours(13, 0, 0, 0);
  if (friday <= new Date()) friday.setDate(friday.getDate() + 7);
  mk({ botId: "onboardings", kind: "schedule", name: "Friday report", prompt: "Write the weekly onboarding report for the person. One page.", where: "fresh", schedule: { type: "once", at: friday.toISOString() } });

  for (const t of mock.triggers) t.nextAt = mock.nextAtOf(t);
}

export function trigger(mock: MockEngine, id: string): MockTrigger {
  const t = mock.triggers.find((x) => x.id === id);
  if (!t) throw new EngineError({ code: "not_found", message: "That trigger is gone." });
  return t;
}

export function nextAtOf(mock: MockEngine, t: MockTrigger): string | undefined {
  if (!t.enabled || t.kind !== "schedule" || !t.schedule) return undefined;
  return nextRun(t.schedule)?.toISOString();
}

/** Scheduled runs in the next 24 hours, soonest first, at most 20. */
export function computeUpcoming(mock: MockEngine): Upcoming[] {
  const end = Date.now() + 24 * 3600_000;
  const out: Upcoming[] = [];
  for (const t of mock.triggers) {
    if (!t.enabled || t.kind !== "schedule" || !t.schedule) continue;
    let from = new Date();
    for (let n = 0; n < 20; n++) {
      const next = nextRun(t.schedule, from);
      if (!next || next.getTime() > end) break;
      out.push({ at: next.toISOString(), botId: t.botId, triggerId: t.id, name: t.name });
      from = next;
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(0, 20);
}

export function refreshUpcoming(mock: MockEngine): void {
  const next = mock.computeUpcoming();
  if (JSON.stringify(next) === JSON.stringify(mock.upcomingList)) return;
  mock.upcomingList = next;
  mock.emit({ event: "upcoming.updated", data: { upcoming: next } });
}

export function changed(mock: MockEngine, t: MockTrigger): void {
  t.nextAt = mock.nextAtOf(t);
  mock.emit({ event: "trigger.changed", data: { botId: t.botId, trigger: publicTrigger(t) } });
  mock.refreshUpcoming();
}

export function saveTrigger(mock: MockEngine, botId: string, p: Methods["trigger.save"]["params"]["trigger"], by: Trigger["createdBy"] = "you"): MockTrigger {
  mock.bot(botId);
  const bad = (message: string) => new EngineError({ code: "bad_request", message });
  const name = p.name.trim();
  const prompt = p.prompt.trim();
  if (!name) throw bad("A trigger needs a name.");
  if (!prompt) throw bad("Say what the bot is told when it runs.");
  if (p.kind === "schedule") {
    if (!p.schedule) throw bad("Choose when it runs.");
    const problem = scheduleProblem(p.schedule);
    if (problem && !(p.schedule.type === "once" && p.id && !p.enabled)) throw bad(problem);
  }
  if (p.id) {
    const t = mock.trigger(p.id);
    if (t.botId !== botId) throw new EngineError({ code: "not_found", message: "That trigger is gone." });
    if (t.kind !== p.kind) throw bad("A trigger cannot change between a schedule and a webhook.");
    Object.assign(t, { name, prompt, where: p.where, enabled: p.enabled, schedule: p.kind === "schedule" ? p.schedule : undefined });
    mock.changed(t);
    return t;
  }
  if (mock.triggers.filter((t) => t.botId === botId).length >= 20) throw bad("A bot can have at most 20 triggers.");
  const t: MockTrigger = { id: `tr${mock.nextId++}`, botId, kind: p.kind, name, prompt, where: p.where, enabled: p.enabled, createdBy: by };
  if (p.kind === "schedule") t.schedule = p.schedule;
  else t.secret = secret();
  mock.triggers.push(t);
  mock.runs.set(t.id, []);
  mock.changed(t);
  return t;
}

export function botSchedules(mock: MockEngine, botId: string, name: string, schedule: Schedule): void {
  mock.saveTrigger(botId, { kind: "schedule", name, prompt: `${name}.`, where: "fresh", enabled: true, schedule }, "bot");
}

export function putRun(mock: MockEngine, t: MockTrigger, run: TriggerRun): void {
  const list = mock.runs.get(t.id) ?? [];
  const i = list.findIndex((r) => r.id === run.id);
  if (i >= 0) list[i] = run;
  else list.unshift(run);
  mock.runs.set(t.id, list);
  t.lastRun = run;
  mock.emit({ event: "trigger.run", data: { run } });
  mock.emit({ event: "trigger.changed", data: { botId: t.botId, trigger: publicTrigger(t) } });
}

/** Fires a trigger: a schedule coming due, a webhook call, or "Run now". */
export function fireTrigger(mock: MockEngine, t: MockTrigger, body?: unknown, now = false): TriggerRun {
  const bot = mock.bot(t.botId);
  const previous = t.lastRun;
  if (!now && previous?.status === "running") {
    const skipped: TriggerRun = { id: `run${mock.nextId++}`, triggerId: t.id, botId: t.botId, at: new Date().toISOString(), status: "skipped", note: "The last run was still going" };
    mock.putRun(t, skipped);
    return skipped;
  }
  const text = t.kind === "webhook" ? hookText(t.prompt, body) : t.prompt;
  const run: TriggerRun = { id: `run${mock.nextId++}`, triggerId: t.id, botId: t.botId, at: new Date().toISOString(), status: "running" };
  if (t.where === "main") {
    const busy = mock.turns.has(bot.id);
    const item = mock.add<UserItem>(bot.mainThreadId, { kind: "user", from: { type: "trigger", label: t.name }, queued: busy, text });
    run.threadId = bot.mainThreadId;
    mock.runOfItem.set(item.id, run);
    mock.putRun(t, run);
    mock.upsert(item);
    if (!busy) void mock.runTurn(bot.id, item, {});
  } else {
    const threadId = `run-${mock.nextId++}`;
    mock.threads.set(threadId, []);
    run.threadId = threadId;
    mock.putRun(t, run);
    void mock.runFresh(t, run, text);
  }
  if (t.schedule?.type === "once") {
    t.enabled = false;
    mock.changed(t);
  }
  return run;
}

/** A fresh run: its own thread, one turn when the bot is free, the result passed on or not. */
export async function runFresh(mock: MockEngine, t: MockTrigger, run: TriggerRun, text: string): Promise<void> {
  const botId = t.botId;
  while (mock.turns.has(botId)) await later(200);
  if (!mock.bots.some((b) => b.id === botId)) return;
  const threadId = run.threadId!;
  const turnId = `turn${mock.nextId++}`;
  const turn: Turn = { botId, threadId, stopped: false };
  mock.turns.set(botId, turn);
  mock.upsert(mock.add<UserItem>(threadId, { kind: "user", from: { type: "trigger", label: t.name }, queued: false, turnId, text }));
  mock.putRun(t, { ...run, turnId });
  mock.setState(botId, "working", `Running ${t.name}`);
  const tool = mock.add<ActivityItem>(threadId, { kind: "activity", botId, turnId, label: "Read new messages", status: "running" });
  mock.upsert(tool);
  await later(900);
  mock.replace({ ...tool, status: "done", durationMs: 900 });
  const quiet = t.quiet || /only report/i.test(t.prompt);
  const answer = quiet ? NOTHING : TRIGGER_ANSWER;
  mock.upsert(mock.add<BotItem>(threadId, { kind: "bot", botId, turnId, streaming: false, text: answer }));
  mock.turns.delete(botId);
  if (!mock.bots.some((b) => b.id === botId)) return;
  if (quiet) {
    mock.putRun(t, { ...run, turnId, status: "silent", note: NOTHING });
    mock.setState(botId, "idle", `Nothing to report from ${t.name}`);
  } else {
    mock.putRun(t, { ...run, turnId, status: "done", note: firstWords(answer) });
    // Passed on to the main chat as a message from the trigger, without starting a turn there.
    const main = mock.bot(botId).mainThreadId;
    mock.upsert(mock.add<UserItem>(main, { kind: "user", from: { type: "trigger", label: t.name }, queued: false, text: `Result of ${t.name}:\n\n${answer}` }));
    mock.setState(botId, "done", `Finished ${t.name}`);
  }
  const next = mock.threads.get(mock.bot(botId).mainThreadId)!.find((i): i is UserItem => i.kind === "user" && i.queued);
  if (next) void mock.runTurn(botId, next, {});
}
