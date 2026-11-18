// What a change to what a bot sees says in the person's quiet line (docs/main-bot.md: "a long change is
// said in a few words, never printed"). One to three switches read as before, each from what to what
// ("Notion off (was on)"). More are counted by kind and direction, with up to three named, so a trim of
// twenty services and forty skills is one short line, not four lines of grey text cut at 400
// characters (decided 15 Nov 2026). The tool's answer to the bot keeps every switch.

/** One change: a ready-made set, or one switch of a service, a plugin or a skill. */
export type SeesChange =
  | { kind: "set"; words: string }
  | { kind: "service" | "plugin"; to: "on" | "off"; name: string; label: string; words: string }
  | { kind: "skill"; to: "full" | "name"; name: string; words: string };

/** Up to this many switches are written one by one, as before. */
const ONE_BY_ONE = 3;
/** A group of more switches names this many and counts the rest. */
const NAMED = 3;

/** "a, b and c". */
export function andList(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Notion, HubSpot, Stripe and 15 more". */
function named(names: string[]): string {
  return names.length <= NAMED ? andList(names) : `${names.slice(0, NAMED).join(", ")} and ${names.length - NAMED} more`;
}

/**
 * The parts of the person's line for these changes, in order. One to three switches: each as it is
 * ("Notion off (was on)"). More: a set as it is, then one part per group, "12 services and 6 plugins
 * off (Notion, HubSpot, design and 15 more)", "40 skills by name only (docs, pdf, xlsx and 37 more)";
 * a group of up to three names them ("Notion and HubSpot on").
 */
export function seesShort(changes: SeesChange[]): string[] {
  const switches = changes.filter((c) => c.kind !== "set");
  if (switches.length <= ONE_BY_ONE) return changes.map((c) => c.words);
  const parts = changes.filter((c) => c.kind === "set").map((c) => c.words);
  for (const to of ["on", "off"] as const) {
    const group = switches.filter((c): c is Extract<SeesChange, { kind: "service" | "plugin" }> => (c.kind === "service" || c.kind === "plugin") && c.to === to);
    if (!group.length) continue;
    if (group.length <= NAMED) {
      parts.push(`${andList(group.map((c) => c.label))} ${to}`);
      continue;
    }
    const s = group.filter((c) => c.kind === "service").length;
    const p = group.length - s;
    const what = [s ? count(s, "service", "services") : "", p ? count(p, "plugin", "plugins") : ""].filter(Boolean).join(" and ");
    parts.push(`${what} ${to} (${named(group.map((c) => c.name))})`);
  }
  for (const to of ["full", "name"] as const) {
    const group = switches.filter((c): c is Extract<SeesChange, { kind: "skill" }> => c.kind === "skill" && c.to === to);
    if (!group.length) continue;
    const how = to === "full" ? "in full" : "by name only";
    if (group.length <= NAMED) parts.push(`the ${group.length === 1 ? "skill" : "skills"} ${andList(group.map((c) => c.name))} ${how}`);
    else parts.push(`${count(group.length, "skill", "skills")} ${how} (${named(group.map((c) => c.name))})`);
  }
  return parts;
}

/** The person's words for these changes as one piece of a line: one by one with commas, groups with semicolons. */
export function seesShortText(changes: SeesChange[]): string {
  const parts = seesShort(changes);
  return parts.join(changes.filter((c) => c.kind !== "set").length <= ONE_BY_ONE ? ", " : "; ");
}
