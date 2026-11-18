// The bot's own to-do list beside its chat (step 7a): the plan its harness keeps while it works
// (Claude's task tools, Codex's plan). A small calm panel floats at the top right of the chat while
// the bot works or the list has open steps: each step done, doing or to do. It folds to one line,
// "3 of 7". Where it would cover the chat's text (a narrower window) and on the phone it is one line
// above the chat instead, which opens the list over the chat.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Bot, BotPlan, PlanStep } from "../../shared/protocol";
import { usePhone } from "../lib/phone";
import { CheckIcon, ChevronIcon } from "./bits";

/** The panel's width at most, and at least: it floats only where the chat leaves room for it beside its text. */
const PANEL_MAX = 260;
const PANEL_MIN = 184;
/** The room it keeps from the chat's text. */
const GAP = 16;

/** Which bots' lists are folded to one line, while the app is open. */
const folded = new Set<string>();

// A bot at rest with a restored card (bot.atRest) reads "waiting" but is not in a turn.
const busy = (bot: Bot) => bot.state === "thinking" || bot.state === "working" || (bot.state === "waiting" && !bot.atRest);

/** Whether the list shows: it has steps, and the bot works or a step is still open. */
export function planShows(bot: Bot): BotPlan | undefined {
  const plan = bot.plan;
  if (!plan || plan.steps.length === 0) return undefined;
  return busy(bot) || plan.steps.some((s) => s.status !== "completed") ? plan : undefined;
}

const doneOf = (plan: BotPlan) => plan.steps.filter((s) => s.status === "completed").length;
const nowOf = (plan: BotPlan): PlanStep | undefined => plan.steps.find((s) => s.status === "inProgress") ?? plan.steps.find((s) => s.status === "pending");
const STATUS_WORD: Record<PlanStep["status"], string> = { completed: "done", inProgress: "doing now", pending: "to do" };

/**
 * Floating where there is room, else the one-line chip. The decision follows the chat's width: the
 * room beside a text column of at most 680 pixels.
 */
export function PlanPanel({ bot }: { bot: Bot }) {
  const plan = planShows(bot);
  const phone = usePhone();
  const anchor = useRef<HTMLDivElement>(null);
  /** The panel's width where it floats, or 0 where there is no room for it. */
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const el = anchor.current;
    const scroller = el?.parentElement?.querySelector<HTMLElement>(".pb-main-scroll");
    if (!el || !scroller) return;
    const measure = () => {
      const pad = parseFloat(getComputedStyle(scroller).paddingRight) || 0;
      const text = Math.min(680, scroller.clientWidth - 2 * pad);
      // Beside the text, less the chat's own edge, which the panel keeps too.
      const free = (scroller.clientWidth - text) / 2 - pad - GAP;
      setRoom(free >= PANEL_MIN ? Math.min(PANEL_MAX, Math.floor(free)) : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [!!plan]);
  if (!plan) return null;
  return (
    <div className="pb-plan-anchor" ref={anchor} data-mode={!phone && room ? "float" : "chip"} style={!phone && room ? { ["--plan-w" as string]: `${room}px` } : undefined}>
      {!phone && room ? <PlanFloat bot={bot} plan={plan} /> : <PlanChip bot={bot} plan={plan} />}
    </div>
  );
}

function Steps({ plan }: { plan: BotPlan }) {
  return (
    <ol className="pb-plan-steps">
      {plan.steps.map((s, i) => (
        <li className="pb-plan-step" key={i} data-status={s.status}>
          <span className="pb-plan-mark" aria-hidden="true">
            {s.status === "completed" && <CheckIcon />}
          </span>
          <span className="pb-plan-text">{s.text}</span>
          <span className="app-sr">{`, ${STATUS_WORD[s.status]}`}</span>
        </li>
      ))}
    </ol>
  );
}

function PlanFloat({ bot, plan }: { bot: Bot; plan: BotPlan }) {
  const [shut, setShut] = useState(() => folded.has(bot.id));
  const toggle = () => {
    if (shut) folded.delete(bot.id);
    else folded.add(bot.id);
    setShut(!shut);
  };
  const id = `plan-${bot.id}`;
  return (
    <aside className="pb-plan" aria-label={`${bot.name}'s to-do list`} data-shut={shut || undefined}>
      <button type="button" className="pb-plan-head" aria-expanded={!shut} aria-controls={shut ? undefined : id} onClick={toggle}>
        <span className="pb-plan-title">To-do</span>
        <span className="pb-plan-count pb-fade-in" key={doneOf(plan)}>{`${doneOf(plan)} of ${plan.steps.length}`}</span>
        <ChevronIcon />
      </button>
      {!shut && (
        <div className="pb-plan-body" id={id}>
          {plan.explanation && <p className="pb-plan-why">{plan.explanation}</p>}
          <Steps plan={plan} />
        </div>
      )}
    </aside>
  );
}

/** One line above the chat: "3 of 7 · the step now". It opens the list over the chat. */
function PlanChip({ bot, plan }: { bot: Bot; plan: BotPlan }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const now = nowOf(plan);
  const id = `plan-${bot.id}`;
  return (
    <div className="pb-plan-chip-row" ref={wrap}>
      <button type="button" className="pb-plan-chip" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={`${bot.name}'s to-do list, ${doneOf(plan)} of ${plan.steps.length} done${now ? `. Now: ${now.text}` : ""}`} onClick={() => setOpen(!open)}>
        <span className="pb-plan-count">{`${doneOf(plan)} of ${plan.steps.length}`}</span>
        {now && <span className="pb-plan-chip-now pb-fade-in" key={now.text}>{now.text}</span>}
        <ChevronIcon />
      </button>
      {open && (
        <div className="pb-plan pb-plan-drop" id={id} role="region" aria-label={`${bot.name}'s to-do list`}>
          {plan.explanation && <p className="pb-plan-why">{plan.explanation}</p>}
          <Steps plan={plan} />
        </div>
      )}
    </div>
  );
}
