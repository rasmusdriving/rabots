// What a bot sees (docs/sees.md), the mock engine's side: a made-up inventory of services, plugins
// and skills as "sees.inventory" answers it, with the ready-made sets. Nothing is read anywhere.
//
// ?sees= picks how reads go: (absent) they work after a short wait, fail (every read fails), slow
// (each read takes three seconds). &seesset=1 starts every Claude bot on the Coding set, as after a
// reload of a Pobots whose bots have a choice (fix 0.26.3).
// Levers on window.pobotsSees: fail(on), delay(ms), reads() how many reads were made.
import type { BotSees, Methods, SeesInventory, SeesService, SeesSet, SeesSkill } from "../../shared/protocol";

export interface SeesLevers {
  fail(on: boolean): void;
  delay(ms: number): void;
  reads(): number;
}

declare global {
  interface Window {
    pobotsSees?: SeesLevers;
  }
}

const SETS: SeesSet[] = [
  { id: "everything", name: "Everything", hint: "Every service, plugin and skill on this Mac, in full.", sees: null },
  {
    id: "coding",
    name: "Coding",
    hint: "For a bot that writes code: the services and plugins for work are off, and most skills are listed by name only.",
    sees: {
      services: { rest: "off", except: ["plugin:1password:1password"] },
      plugins: { rest: "off", except: ["design@synced", "1password@synced"] },
      skills: { rest: "name", except: ["code-review", "run", "simplify", "security-review", "claude-api", "browser-use", "screenshot", "security-best-practices", "gh-address-comments", "docs", "pptx", "docx"] },
    },
  },
];

/** The Coding set's choice, for bots that start with it (&seesset=1, fix 0.26.3). */
export const CODING_SEES = (): BotSees => structuredClone(SETS[1]!.sees!);

const svc = (name: string, label: string, from: SeesService["from"], tools: number, tokens: number, plugin?: string): SeesService => ({ name, label, from, ...(plugin ? { plugin } : {}), state: "connected", tools, tokens });
const idle = (name: string, label: string, from: SeesService["from"], state: SeesService["state"], plugin?: string): SeesService => ({ name, label, from, ...(plugin ? { plugin } : {}), state, tools: 0, tokens: 0 });
const skill = (name: string, from: SeesSkill["from"], tokens: number): SeesSkill => ({ name, from, tokens, nameTokens: Math.ceil(name.length / 2.5) + 2 });

function inventory(): SeesInventory {
  const signIn = ["Asana", "Atlassian", "Box", "Canva", "Figma", "Gmail", "Google Calendar", "Google Docs", "Google Drive", "Google Sheets", "Google Slides", "Intercom", "Linear", "monday.com", "Pendo", "Slack"];
  return {
    services: [
      svc("claude.ai Notion", "Notion", "claude.ai", 77, 2100),
      svc("claude.ai Microsoft 365", "Microsoft 365", "claude.ai", 50, 1250),
      svc("claude.ai HubSpot", "HubSpot", "claude.ai", 39, 1150),
      svc("claude.ai Stripe", "Stripe", "claude.ai", 38, 1300),
      svc("claude.ai Claude Docs", "Claude Docs", "claude.ai", 8, 1200),
      svc("ado", "ado", "mac", 20, 500),
      svc("claude.ai Zendesk", "Zendesk", "claude.ai", 14, 380),
      svc("claude.ai Claude Data", "Claude Data", "claude.ai", 11, 620),
      svc("hubspot-session", "hubspot-session", "mac", 9, 360),
      svc("plugin:1password:1password", "1password", "plugin", 8, 340, "1password@synced"),
      svc("codex-cu", "codex-cu", "mac", 3, 90),
      ...signIn.map((n) => idle(`claude.ai ${n}`, n, "claude.ai", "needs-sign-in")),
      idle("codex", "codex", "mac", "failed"),
      idle("plugin:data:hex", "data hex", "plugin", "needs-sign-in", "data@synced"),
      idle("plugin:data:snowflake", "data snowflake", "plugin", "failed", "data@synced"),
    ],
    plugins: [
      { id: "1password@synced", name: "1password", skills: 1, services: 1, tokens: 420 },
      { id: "data@synced", name: "data", skills: 10, services: 2, tokens: 780 },
      { id: "design@synced", name: "design", skills: 7, services: 0, tokens: 670 },
      { id: "enterprise-search@synced", name: "enterprise-search", skills: 5, services: 0, tokens: 450 },
      { id: "productivity@synced", name: "productivity", skills: 4, services: 0, tokens: 360 },
    ],
    skills: [
      skill("agent-demo-film", "mac", 106),
      skill("artifact-design", "built-in", 66),
      skill("brand-design", "claude.ai", 303),
      skill("browser-use", "mac", 226),
      skill("claude-api", "built-in", 390),
      skill("code-review", "built-in", 280),
      skill("dataviz", "built-in", 482),
      skill("docs", "claude.ai", 343),
      skill("docx", "claude.ai", 320),
      skill("gh-address-comments", "mac", 40),
      skill("help-center", "claude.ai", 261),
      skill("legal-dpa", "claude.ai", 188),
      skill("loop", "built-in", 115),
      skill("pdf", "claude.ai", 7),
      skill("pptx", "claude.ai", 260),
      skill("run", "built-in", 123),
      skill("schedule", "built-in", 127),
      skill("screenshot", "mac", 60),
      skill("security-best-practices", "mac", 70),
      skill("security-review", "built-in", 30),
      skill("simplify", "built-in", 63),
      skill("weekly-notes", "bot", 90),
    ],
    sets: SETS,
    readAt: new Date().toISOString(),
  };
}

export class MockSees {
  private failing: boolean;
  private waitMs: number;
  private count = 0;
  private kept: SeesInventory | null = null;

  constructor(flag: string | null | undefined) {
    this.failing = flag === "fail";
    this.waitMs = flag === "slow" ? 3000 : 400;
  }

  /** The extra wait of one read, before the mock answers. */
  wait(): number {
    return this.waitMs;
  }

  levers(): SeesLevers {
    return {
      fail: (on) => {
        this.failing = on;
      },
      delay: (ms) => {
        this.waitMs = ms;
      },
      reads: () => this.count,
    };
  }

  readonly handlers = {
    "sees.inventory": (_p: Methods["sees.inventory"]["params"]): Methods["sees.inventory"]["result"] => {
      this.count += 1;
      if (this.failing) return { inventory: this.kept, problem: "What this bot can see could not be read just now. Try again in a moment." };
      this.kept = inventory();
      return { inventory: this.kept };
    },
  };
}
