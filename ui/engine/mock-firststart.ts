// Engine 0.33.0 (protocol 24): a new install's first start and "About you" (the window check's section
// "firststart"; docs/build/step-first-start.md). In ?scene=first-run the roster is empty; the first-start
// screen's bot.create sends `welcome`, and the main bot then greets the person by itself, as the engine
// does. "aboutYou.set" works in every scene; &aboutyou=1 starts with a note written.
// window.pobotsFirstStart: welcomed() (how many welcome turns started), aboutYou() (the text as kept),
// fromBot(text) (the main bot writes it with change_settings: the event and the quiet line).
import type { BotItem, Methods, NoticeItem } from "../../shared/protocol";
import type { MockEngine } from "./mock";
import { EngineError } from "./types";
import { later } from "./mock-data";

const MAX = 4000;

export const SAMPLE_ABOUT_YOU = "Ada runs customer onboarding at Example Ltd (example.com).\nShe cares about clear plans and short updates.\nShe likes plain words and the result first.";

const GREETING =
  "Hello, I am {name}, your main bot. I help you run your bots in Pobots, and I can make new ones for you. To start, tell me a little about yourself: who are you, and what do you do?";

export interface FirstStartLevers {
  welcomed(): number;
  aboutYou(): string;
  fromBot(text: string): void;
}

declare global {
  interface Window {
    pobotsFirstStart?: FirstStartLevers;
  }
}

function words(text: string): string {
  const n = text.trim().split(/\s+/).filter(Boolean).length;
  return n === 1 ? "1 word" : `about ${n} words`;
}

export class MockFirstStart {
  text: string;
  private welcomes = 0;

  constructor(
    private readonly mock: MockEngine,
    flag: string | null,
  ) {
    this.text = flag === "1" ? SAMPLE_ABOUT_YOU : "";
  }

  /** Writes the note; the change words for a quiet line, or "" when nothing changed. */
  private put(raw: string): string {
    const text = raw.replace(/\r\n?/g, "\n").trim();
    if (text.length > MAX) throw new EngineError({ code: "bad_request", message: "About you is too long. Keep it under 4,000 characters." });
    if (text === this.text) return "";
    const was = this.text;
    this.text = text;
    this.mock.emit({ event: "aboutYou.changed", data: { aboutYou: text } });
    if (!text) return "About you cleared";
    return `About you ${was ? "changed" : "written"} (${words(text)})`;
  }

  readonly handlers: { "aboutYou.set": (p: Methods["aboutYou.set"]["params"]) => Methods["aboutYou.set"]["result"] } = {
    "aboutYou.set": (p) => {
      this.put(p.text);
      return { aboutYou: this.text };
    },
  };

  /** After bot.create with `welcome` made the main bot: its greeting streams in by itself. */
  welcome(botId: string): void {
    const bot = this.mock.bots.find((b) => b.id === botId);
    if (!bot || bot.role !== "main") return;
    this.welcomes++;
    void this.greet(botId, bot.mainThreadId, GREETING.replace("{name}", bot.name));
  }

  private async greet(botId: string, threadId: string, text: string): Promise<void> {
    this.mock.setState(botId, "thinking", "Thinking");
    await later(600);
    const turnId = `tw-${Date.now()}`;
    let item = this.mock.add<BotItem>(threadId, { kind: "bot", botId, turnId, text: "", streaming: true });
    this.mock.upsert(item);
    for (const delta of text.split(/(?<=\s)/)) {
      await later(30);
      item = { ...item, text: item.text + delta };
      const list = this.mock.threads.get(threadId);
      const i = list?.findIndex((x) => x.id === item.id) ?? -1;
      if (list && i >= 0) list[i] = item;
      this.mock.emit({ event: "item.delta", data: { threadId, itemId: item.id, textDelta: delta } });
    }
    this.mock.replace({ ...item, streaming: false });
    this.mock.settle(botId, "done", `Answered at ${new Date().toTimeString().slice(0, 5)}`);
  }

  levers(): FirstStartLevers {
    return {
      welcomed: () => this.welcomes,
      aboutYou: () => this.text,
      fromBot: (text) => {
        const line = this.put(text);
        const main = this.mock.bots.find((b) => b.role === "main");
        if (line && main) this.mock.upsert(this.mock.add<NoticeItem>(main.mainThreadId, { kind: "notice", tone: "info", text: `Pobots settings: ${line}` }));
      },
    };
  }
}
