import type { Bot, Methods, NoticeItem, Todo, TriggerRun } from "../../shared/protocol";
import type { MockEngine } from "./mock";
import { EngineError } from "./types";

const KEY = "pobots:mock-vacation";

export class MockVacation {
  private since: Record<string, string> = {};
  constructor(private mock: MockEngine, private todos: () => Todo[]) {
    if (mock.flags.get("vacation") !== "1") return;
    try { this.since = JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { /* Start empty. */ }
    mock.bots = mock.bots.map((b) => this.since[b.id] ? { ...b, vacationSince: this.since[b.id], state: "idle", activity: "On vacation" } : b);
    for (const t of mock.triggers) if (this.since[t.botId]) t.resting = true;
    mock.refreshUpcoming();
  }

  set(p: Methods["bot.vacation"]["params"]): Methods["bot.vacation"]["result"] {
    const { mock } = this;
    const bot = mock.bot(p.botId);
    if (bot.role === "main") throw new EngineError({ code: "bad_request", message: "The main bot stays available to bring other bots back." });
    if (!!bot.vacationSince === p.vacation) return { bot, missedOnce: 0 };
    const turn = mock.turns.get(bot.id);
    if (p.vacation && (turn || bot.state === "working" || bot.state === "thinking" || (bot.state === "waiting" && !bot.atRest)) && !p.stop) {
      throw new EngineError({ code: "conflict", message: "The bot is working. Stop it and send it on vacation." });
    }
    const next: Bot = { ...bot, state: "idle", activity: p.vacation ? "On vacation" : "" };
    if (p.vacation) {
      if (turn) turn.stopped = true;
      mock.turns.delete(bot.id);
      next.vacationSince = new Date().toISOString();
      this.since[bot.id] = next.vacationSince;
    } else {
      delete next.vacationSince;
      delete this.since[bot.id];
    }
    if (mock.flags.get("vacation") === "1") {
      try { localStorage.setItem(KEY, JSON.stringify(this.since)); } catch { /* Only for reload in the check. */ }
    }
    mock.putBot(next);
    let missedOnce = 0;
    for (const t of mock.triggers.filter((t) => t.botId === bot.id)) {
      if (p.vacation) t.resting = true;
      else {
        delete t.resting;
        if (t.enabled && t.schedule?.type === "once" && Date.parse(t.schedule.at) <= Date.now()) {
          t.enabled = false;
          missedOnce++;
          const run: TriggerRun = { id: `run${mock.nextId++}`, triggerId: t.id, botId: bot.id, at: new Date().toISOString(), status: "skipped", note: "Its time passed while the bot was on vacation" };
          mock.putRun(t, run);
        }
      }
      mock.changed(t);
    }
    for (const card of mock.cards) {
      if (card.kind === "system" || card.botId !== bot.id) continue;
      if (p.vacation) mock.emit({ event: "card.removed", data: { cardId: card.id, reason: "withdrawn" } });
      else mock.emit({ event: "card.changed", data: { card } });
    }
    for (const todo of this.todos().filter((t) => t.botId === bot.id)) {
      if (p.vacation) mock.emit({ event: "todo.removed", data: { todoId: todo.id, reason: "vacation" } });
      else mock.emit({ event: "todo.changed", data: { todo } });
    }
    const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(bot.vacationSince ?? Date.now()));
    mock.upsert(mock.add<NoticeItem>(bot.mainThreadId, { kind: "notice", tone: "info", text: p.vacation ? "Sent on vacation." : `Back from vacation. Away since ${date}.` }));
    return { bot: mock.bot(bot.id), missedOnce };
  }
}

export function requireMockPresent(bot: Bot): void {
  if (bot.vacationSince) throw new EngineError({ code: "conflict", message: `${bot.name} is on vacation. Only the person or the main bot can bring it back.` });
}
