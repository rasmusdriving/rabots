// Waiting messages (step 7a): they stand in a stack above the message box until the bot takes one;
// then it stands in the chat where it was read.
import type { Item } from "../../shared/protocol";

/**
 * The items in the order the chat reads: a message that started a turn stands right before that
 * turn's first line, also in history from before the engine moved such messages itself (until
 * protocol 15 a waiting message kept the place where it was sent, above the work it waited for).
 * A message steered into a turn stays where it went in.
 */
export function inReadOrder(items: Item[]): Item[] {
  const firstOut = new Map<string, number>();
  items.forEach((i, at) => {
    if (i.kind !== "user" && i.turnId && !firstOut.has(i.turnId)) firstOut.set(i.turnId, at);
  });
  const moves = new Map<number, Item[]>();
  const moved = new Set<number>();
  items.forEach((i, at) => {
    if (i.kind !== "user" || !i.turnId || i.steered || i.queued) return;
    const turnId = i.turnId;
    const first = firstOut.get(turnId);
    // A turn with nothing of its own yet (just begun, or stopped before it did anything): it stays.
    // The engine itself moves a message to the end when it is taken (protocol 15).
    if (first === undefined) return;
    // Something of another turn (or no turn) stands between it and its own turn's first line.
    const end = first;
    let between = false;
    for (let k = at + 1; k < end; k++) {
      const x = items[k]!;
      if (x.turnId !== turnId && !(x.kind === "user" && x.queued)) {
        between = true;
        break;
      }
    }
    if (!between) return;
    moved.add(at);
    const list = moves.get(end) ?? [];
    list.push(i);
    moves.set(end, list);
  });
  if (!moved.size) return items;
  const out: Item[] = [];
  items.forEach((i, at) => {
    for (const m of moves.get(at) ?? []) out.push(m);
    if (!moved.has(at)) out.push(i);
  });
  return out;
}

/** Where each waiting message last stood in the stack, by its item id, for the move into the chat. */
const stackPlaces = new Map<string, { top: number; left: number; at: number }>();

/** The stack notes where a message stood before it leaves (it may be about to move into the chat). */
export function noteStackPlace(itemId: string, el: Element): void {
  const r = el.getBoundingClientRect();
  if (r.height > 0) stackPlaces.set(itemId, { top: r.top, left: r.left, at: Date.now() });
}

/** How long a noted place counts: the message appears in the chat in the same moment or not at all. */
const PLACE_MS = 1500;

/**
 * A ref for a message in the chat: when it has just left the stack, it glides from where it stood
 * there to its place, calmly, so the eye can follow it and nothing seems to jump. Without motion (or
 * when it did not come from the stack) it simply stands there.
 */
export function arriveFromStack(itemId: string): (el: HTMLElement | null) => void {
  return (el) => {
    if (!el) return;
    const from = stackPlaces.get(itemId);
    if (!from) return;
    stackPlaces.delete(itemId);
    if (Date.now() - from.at > PLACE_MS) return;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof el.animate !== "function") return;
    // After layout: the chat may still be put at its bottom in this frame.
    requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      const dy = from.top - r.top;
      if (Math.abs(dy) < 1 || Math.abs(dy) > 400) return;
      const dur = parseFloat(getComputedStyle(el).getPropertyValue("--dur-quick")) || 0;
      const easing = getComputedStyle(el).getPropertyValue("--ease-soft").trim() || "ease-out";
      for (const a of el.getAnimations()) a.finish();
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: dur || 180, easing });
    });
  };
}
