// Helpers at work (protocol 19, docs/build/step-helpers-in-rail.md): the helpers of a bot that
// work now, as the window lists them in one place, wherever their rows stand.
import type { WorkingHelper } from "../../shared/protocol.js";
import type { Engine } from "../engine.js";
import { helperHome } from "./helpers.js";
import type { BotRuntime } from "./runtime.js";

/** Every helper of the bot that works now, in the order they started; undefined when none. */
export function workingHelpers(eng: Engine, rt: BotRuntime): WorkingHelper[] | undefined {
  if (!rt.helpers.size) return undefined;
  const out: WorkingHelper[] = [];
  for (const h of rt.helpers.values()) {
    const b = h.base;
    const parent = h.parent ? rt.helpers.get(h.parent) : undefined;
    const home = helperHome(eng, rt, h);
    out.push({
      itemId: b.id,
      threadId: b.threadId,
      helperThreadId: b.helperThreadId,
      title: b.title,
      ...(b.harness ? { harness: b.harness } : {}),
      ...(b.model ? { model: b.model } : {}),
      ...(b.effort ? { effort: b.effort } : {}),
      startedAt: b.at,
      ...(home !== rt.threadId && h.purpose.runLabel ? { inRun: h.purpose.runLabel } : {}),
      ...(parent ? { parentItemId: parent.base.id } : {}),
      // Engine 0.26.0: a task manager's worker names its manager.
      ...(h.manager ? { managerId: h.manager, taskManager: rt.managers.get(h.manager)?.title ?? "" } : {}),
    });
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
