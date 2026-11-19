// What every part of the Ahead page may reach (protocol 31): the view's today, the item sheet, and
// the page's choices. Parts B and C read and add to it here rather than through props.
import { createContext, useContext } from "react";
import type { AheadItem } from "../../../shared/protocol";
import type { AheadModel } from "./ahead-state";

export interface AheadPageContext {
  today: string;
  model: AheadModel;
  /** Opens the item sheet for an item. */
  openItem(item: AheadItem): void;
  /** The bot whose rows show, or null for everyone (YOUR_ITEMS for the person's own). */
  only: string | null;
  setOnly(id: string | null): void;
  hideMeetings: boolean;
  setHideMeetings(on: boolean): void;
  label: string;
  setLabel(label: string): void;
  week: boolean;
  setWeek(on: boolean): void;
}

export const DonePlace = createContext(false);

export const AheadContext = createContext<AheadPageContext | null>(null);

export function useAheadPage(): AheadPageContext {
  const c = useContext(AheadContext);
  if (!c) throw new Error("useAheadPage outside the Ahead page");
  return c;
}
