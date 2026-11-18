// The quiet line at the end of an answer while the bot works and nothing else is live: "Thinking",
// or the engine's words for what it does. When it waits for helpers ("Waiting for a helper",
// "Waiting for 3 helpers"), the line leads to them (docs/build/step-helpers-in-rail.md): one helper,
// its thread opens; several, their rows are shown and marked. Same place and box either way.
import type { Bot } from "../../shared/protocol";
import { AT_WORK_WORDS, sharedRun, showWaitedOn } from "../lib/helpers-at-work";
import { Mark } from "./bits";

/** The engine's words while a bot waits for its helpers (engine/core/words.ts, waitingWords); not "Waiting for your answer". */
const WAITS_ON_HELPERS = /^Waiting for (a helper|\d+ helpers)$/;

export function WaitingLine({ bot, words }: { bot?: Bot; words: string }) {
  const list = bot?.workingHelpers ?? [];
  const waiting = !!bot && list.length > 0 && WAITS_ON_HELPERS.test(words);
  const run = waiting ? sharedRun(list) : undefined;
  const text = run ? AT_WORK_WORDS.inRun(words, run) : words;
  return (
    <div className="pb-pending pb-arrive" role="status">
      {waiting ? (
        <button
          type="button"
          className="pb-pending-line pb-pending-go"
          aria-label={`${text}. ${list.length === 1 ? "Open its thread" : "Show them"}`}
          onClick={(e) => showWaitedOn(bot!, list, e.currentTarget)}
        >
          <Mark state="thinking" />
          <span className="pb-pending-words">{text}</span>
        </button>
      ) : (
        <span className="pb-pending-line">
          <Mark state="thinking" />
          <span>{text}</span>
        </span>
      )}
    </div>
  );
}
