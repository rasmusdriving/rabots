// The setup guides for the Power Automate flows (docs/guides/, docs/build/step-flow-guides.md). The build
// copies them beside the engine (dist/engine/guides/), because an installed Pobots holds only dist/; run
// from the source (the tests, a dev engine started with tsx) they are read in the repository. The bots are
// told the full path, so they read them without the internet, and a Claude bot reads a file there without
// a card (engine/core/cards.ts).
import { existsSync, realpathSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const GUIDE_FILES = { calendar: "calendar-flow.md", teams: "teams-channel-flows.md" } as const;
export type GuideName = keyof typeof GUIDE_FILES;

let found: string | undefined;

/** The folder with the guides: the build's copy beside main.mjs, else the repository's docs/guides. */
export function guidesDir(): string {
  if (found) return found;
  const candidates = [new URL("./guides/", import.meta.url), new URL("../../docs/guides/", import.meta.url)].map((u) => fileURLToPath(u));
  found = candidates.find((dir) => existsSync(join(dir, GUIDE_FILES.calendar))) ?? candidates[0]!;
  return found;
}

/** The full path of one guide, as the bots are told it. */
export function guidePath(name: GuideName): string {
  return join(guidesDir(), GUIDE_FILES[name]);
}

/** Whether a path a bot wants to read is inside the guides folder (no climbing out with ..). */
export function insideGuides(path: unknown): boolean {
  if (typeof path !== "string" || !path || !isAbsolute(path)) return false;
  const within = (dir: string, p: string) => {
    const rel = relative(dir, p);
    return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
  };
  if (!within(guidesDir(), resolve(path))) return false;
  // A link inside the folder that leads out of it does not count.
  try {
    return within(realpathSync(guidesDir()), realpathSync(path));
  } catch {
    return false;
  }
}

/** The words that point a bot to a guide: one short sentence. */
export function guideWords(name: GuideName): string {
  const what = name === "calendar" ? "setting up the calendar flow" : "setting up the Teams channel flows";
  return `The guide for ${what}, to go through with the person, is ${guidePath(name)}.`;
}
