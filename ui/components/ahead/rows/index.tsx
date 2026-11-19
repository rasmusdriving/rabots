// The row for each source (protocol 31). Part B and C add theirs here: a source of their own in
// ROWS, or a kind of item drawn its own way in ITEM_ROWS (part B's "your time").
import type { ComponentType } from "react";
import type { AheadItemRow, AheadKind, AheadRow, AheadSource } from "../../../../shared/protocol";
import { ItemRow } from "./ItemRow";
import { MeetingRow } from "./MeetingRow";
import { RunRow } from "./RunRow";
import { TodoRow } from "./TodoRow";
import { RowChange } from "./RowShell";
import { YourTimeRow } from "../time/YourTimeRow";

type RowOf<S extends AheadSource> = Extract<AheadRow, { source: S }>;

export const ROWS: { [S in AheadSource]: ComponentType<{ row: RowOf<S> }> } = {
  item: ItemRow,
  meeting: MeetingRow,
  todo: TodoRow,
  run: RunRow,
};

/** An item kind drawn its own way; the others use ItemRow. */
export const ITEM_ROWS: Partial<Record<AheadKind, ComponentType<{ row: AheadItemRow }>>> = { "your-time": YourTimeRow };

export function AheadRowView({ row }: { row: AheadRow }) {
  if (row.source === "item") {
    const Own = ITEM_ROWS[row.item.kind] ?? ItemRow;
    return <RowChange.Provider value={row.changed}><Own row={row} /></RowChange.Provider>;
  }
  const Row = ROWS[row.source] as ComponentType<{ row: AheadRow }>;
  return <RowChange.Provider value={row.changed}><Row row={row} /></RowChange.Provider>;
}
