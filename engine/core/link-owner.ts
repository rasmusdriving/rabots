// Engine 0.44.0: which bot a connection belongs to (docs/decisions.md, 20 Nov 2026). A routing rule
// for Pobots' own tools, like T3 Code's link origin: the owner's chat gets the messages and only the
// owner sends. A saved owner is a bot id; none means the main bot, so every older connection is its.
import { EngineError } from "../errors.js";
import type { Engine } from "../engine.js";
import type { LinkOwners } from "./links.js";
import type { BotRuntime } from "./runtime.js";

export function mainBot(eng: Engine): BotRuntime | undefined {
  return eng.order.map(id => eng.bots.get(id)).find(rt => rt?.folder.file.role === "main");
}

/** The bot a saved owner means now: that bot, or the main bot when none is saved or it is gone. */
export function ownerRuntime(eng: Engine, saved: string | undefined): BotRuntime | undefined {
  return (saved ? eng.bots.get(saved) : undefined) ?? mainBot(eng);
}

/** Whether a saved owner names a bot that is no longer there (its folder went without a retire). */
export function ownerGone(eng: Engine, saved: string | undefined): boolean {
  return !!saved && !eng.bots.has(saved);
}

/** A new owner by id or name: undefined for the main bot (saved as none), else the bot's id. */
export function checkOwner(eng: Engine, owner: string): string | undefined {
  const wanted = owner.trim();
  const rt = eng.bots.get(wanted)
    ?? [...eng.bots.values()].find(b => b.folder.file.name.toLowerCase() === wanted.toLowerCase());
  if (!rt) {
    const names = eng.order.map(id => eng.bots.get(id)?.folder.file.name).filter(Boolean).join(", ");
    throw new EngineError("bad_request", `There is no bot called ${JSON.stringify(wanted)}. Choose one of: ${names}.`);
  }
  return rt.folder.file.role === "main" ? undefined : rt.folder.id;
}

/** Whether a bot that is not the main bot owns a connection now, so it gets message_pobots. */
export function ownsConnection(eng: Engine, rt: BotRuntime): boolean {
  return rt.folder.file.role !== "main" && eng.links.owned(rt.folder.id).length > 0;
}

export function linkOwners(eng: Engine): LinkOwners {
  return {
    of: saved => ownerRuntime(eng, saved)?.folder.id ?? saved ?? "",
    check: owner => checkOwner(eng, owner),
    name: botId => eng.bots.get(botId)?.folder.file.name ?? "the main bot",
    // On vacation its messages wait, unseen, until it is back (a missing bot's go to the main bot).
    held: saved => !!saved && !!eng.bots.get(saved)?.folder.file.vacationSince,
    // Its tools change from its next turn: message_pobots comes or goes with a new session.
    moved: botIds => {
      for (const id of botIds) {
        const rt = eng.bots.get(id);
        if (rt && rt.folder.file.role !== "main") eng.refreshSession(rt);
      }
    },
  };
}
