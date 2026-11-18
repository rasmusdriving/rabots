// Long words and addresses in every part of the "Needs you" rail (&longtext=1, the window check's
// section "railresize", 17 Nov 2026): a "tells you" card with a long address as it was seen run
// past the rail's edge, questions with long choices and a text field, an approval with a long
// detail, a card from Pobots, a to-do, a helper at work and a "Later today" line. Nothing in the
// rail may reach past its edge.
import type { MockEngine } from "./mock";
import { atWorkLevers } from "./mock-atwork";
import { today } from "./mock-data";

export const LONG_URL =
  "https://example.com/workspace/onboardings/Nordvik-kickoff-notes-and-every-decision-of-the-week-2b9c1f0e7a8d4c3b9e6f5a2d1c0b8e7f?pvs=4&source=copy_link";
export const LONG_WORD = "Onboardingstatusrapporteringsverktygskonfigurationsdokumentationen";

export function seedLongText(mock: MockEngine): void {
  const onboardings = mock.bot("onboardings");
  const kaja = mock.bot("kaja");
  mock.cards.push(
    {
      kind: "note",
      id: "c-long-note",
      botId: "onboardings",
      threadId: onboardings.mainThreadId,
      at: today(9, 18),
      title: `The notes are in ${LONG_WORD}`,
      text: `I put the kickoff notes on the page: ${LONG_URL}`,
    },
    {
      kind: "question",
      id: "c-long-choices",
      botId: "kaja",
      threadId: kaja.mainThreadId,
      at: today(9, 19),
      title: `Which ${LONG_WORD} should I use?`,
      text: `The one at ${LONG_URL} or the older copy.`,
      choices: [
        { id: "new", label: `The new ${LONG_WORD}` },
        { id: "old", label: "The older copy" },
      ],
      allowText: false,
    },
    {
      kind: "question",
      id: "c-long-typed",
      botId: "kaja",
      threadId: kaja.mainThreadId,
      at: today(9, 20),
      title: "Where should the report go?",
      text: `Today it lies at ${LONG_URL}.`,
      choices: [],
      allowText: true,
    },
    {
      kind: "approval",
      id: "c-long-approval",
      botId: "onboardings",
      threadId: onboardings.mainThreadId,
      at: today(9, 21),
      title: `Open ${LONG_URL}?`,
      caption: `mcp__browser__open_${LONG_WORD.toLowerCase()}`,
      detail: `${LONG_URL}\n\n${LONG_WORD}`,
    },
    {
      kind: "system",
      id: "c-long-system",
      topic: "backup",
      at: today(9, 22),
      title: `Last night's backup failed: ${LONG_WORD}`,
      text: `The folder ${LONG_URL} could not be read.`,
    },
  );
  window.pobotsTodos?.add({ botId: "kaja", title: `Read ${LONG_WORD} at ${LONG_URL}` });
  atWorkLevers(mock).start("onboardings", { title: `Read ${LONG_URL}`, minutes: 3 });
  // The last trigger of the day gets a long name, for its line under "Later today".
  const late = [...mock.triggers].reverse().find((t) => t.kind === "schedule");
  if (late) late.name = `${LONG_WORD} for ${LONG_URL}`;
}
