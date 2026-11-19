import type { AheadItem, AheadItemRow, AheadRow, AheadView } from "../../../shared/protocol";

export const SECTIONS = ["earlier", "rows", "later", "done"] as const;

/** Ignore changes in the read boundary: marks belong to this visit. */
const sig = (r: AheadRow) => {
  const { changed: _changed, ...rest } = r;
  return JSON.stringify(rest);
};

export function differences(a: AheadView, b: AheadView, mine: Map<string, AheadItem>) {
  const signatures = (v: AheadView) => {
    const out = new Map<string, string>();
    for (const s of SECTIONS) for (const r of v[s]) {
      if (!(r.source === "item" && mine.has(r.item.id))) out.set(r.key, `${s}|${sig(r)}`);
    }
    return out;
  };
  const x = signatures(a);
  const y = signatures(b);
  let added = 0;
  let changed = 0;
  for (const [k, s] of y) {
    if (!x.has(k) && !s.startsWith("done|")) added++;
    else if (x.get(k) !== s) changed++;
  }
  for (const k of x.keys()) if (!y.has(k)) changed++;
  return { added, changed };
}

const replace = (r: AheadItemRow, item: AheadItem): AheadItemRow => ({ ...r, item });
const itemRow = (item: AheadItem): AheadItemRow => ({ source: "item", key: `item:${item.id}`, day: item.day, time: item.time, item });

/** Keep the original slot of anything the person acted on. Do not resettle the rest for a local action. */
export function applyLocal(view: AheadView, item: AheadItem, added = false): AheadView {
  const swap = (rows: AheadRow[]) => rows.map((r) => r.source === "item" && r.item.id === item.id ? replace(r, item) : r);
  const next = { ...view, earlier: swap(view.earlier), rows: swap(view.rows), later: swap(view.later) };
  if (added) {
    const section = item.day < view.today ? "earlier" : item.day > view.to ? "later" : "rows";
    next[section].push(itemRow(item));
  }
  const inOpen = [next.earlier, next.rows, next.later].some((rows) => rows.some((r) => r.key === `item:${item.id}`));
  const inDone = view.done.some((r) => r.item.id === item.id);
  if (inDone) next.done = item.state === "open" && inOpen ? view.done.filter((r) => r.item.id !== item.id) : view.done.map((r) => r.item.id === item.id ? replace(r, item) : r);
  else if (item.state !== "open") next.done = [...view.done, itemRow(item)];
  return next;
}

export function keepVisit(next: AheadView, shown: AheadView | undefined, mine: Map<string, AheadItem>): AheadView {
  if (!shown) return next;
  const merge = <R extends AheadRow>(incoming: R[], previous: R[]): R[] => {
    const marks = new Map(previous.filter((r) => r.changed).map((r) => [r.key, r] as const));
    const out = incoming.flatMap((r) => {
      if (r.source === "item" && mine.has(r.item.id)) return [];
      const old = marks.get(r.key);
      return [old && !r.changed && sig(old) === sig(r) ? { ...r, changed: old.changed } : r];
    });
    previous.forEach((r, at) => {
      if (r.source === "item" && mine.has(r.item.id)) out.splice(at, 0, r);
    });
    return out;
  };
  return {
    ...next,
    earlier: merge(next.earlier, shown.earlier),
    rows: merge(next.rows, shown.rows),
    later: merge(next.later, shown.later),
    done: merge(next.done, shown.done),
    screen: next.screen && { ...next.screen, seenAt: shown.screen?.seenAt },
  };
}
