A helper is a worker a bot starts for one task, on its own model or on one it chooses (also a GPT model for a bot on Claude, and the other way round). It is not a bot: it has no folder, no memory and no name, and it is gone when its task is done. The person must still see that it exists, what it is doing now, and what it said and did. So each helper is one row in the chat where the bot started it, and a thread of its own that opens from that row, in the place of the bot's chat.

The word is always "helper" in anything the person reads. Never subagent, agent, task or worker.

## The row (`pb-helper`)

One button, from left to right:

- **The helper's mark** (`pb-helper-mark`): a small drawn arrow turning in under a line, on a soft `fill` disc, like the marks for triggers and channels. Never a face: a helper is not a bot.
- **The title** (`pb-helper-title`), the task in a few words as the bot named it, in `ink` at weight 600 (the ink of a name), 13px, cut with an ellipsis.
- **One line under it** (`pb-helper-last`), 12px `ink-muted`, cut with an ellipsis: the step that runs now ("Reading AGENTS.md"), or the start of what it said last; at the end, the start of its result. "Starting" before its first step.
- **At the right** (`pb-helper-state`): the state in a word and the time, joined by a middle dot. "Working" with the thinking dots (the same quiet sign of life as the pending line), and how long it has worked once that is a minute or more ("Working · 3 min"). "Finished · 14:52", "Failed · 14:52" with the word in `clay`, "Stopped · 14:52". The time is when it ended, written like the other times in the chat.
- **An arrow** (`pb-helper-go`): the row opens something in its place.
- **On a phone** (fix 0.26.3): the title has the whole first line, the state with its time and the model label share the second, and the line about now is the third. One fixed height, 68px, in every state. At 360px the title was cut to a few letters beside the label. The laptop keeps the one line above at every width.

Rules:

- **One fixed height (52px) in every state**, with or without its line. When a helper starts, changes its line or ends, nothing else in the chat moves. The line changes in place, no sliding, no flashing; the state word fades in over `dur-quick` without travel when it changes.
- **A soft surface, no border, no shadow**: `fill`, `fill-strong` on hover, `radius-md`. Quieter than a message (no face, small type), clearer than a line of work (a surface and a name).
- **Indented under the bot like its lines of work** (`pb-helper-group`, 40px), at the place where the bot started it. Helpers started together are one group of rows with a `space-1` gap, and read as a group.
- On a fill the quiet words are `ink-muted`, never `ink-faint`.
- The whole row opens the helper's thread, by click and with the keyboard. It is one of the chat's line buttons: one Tab stop for all of them (the newest), Up and Down between them, the 2px focus ring.
- In a turn another bot started, which the chat folds into one line, the helper rows are inside the fold like the turn's other lines.
- The rows are pieces of the bot's answer, in the order it started them. When the turn has ended and none of its helpers still works, they fold away with the rest of the work into "Worked for 3m 12s · 2 helpers" (see Message), and show again in place when that line is opened. While one still works, the turn is not folded.
- An activity line "Had a helper ..." from before helpers had rows stays an ordinary activity line.
- A `start_helper` call the engine refuses before any helper starts (no model and no kind, a kind that is missing, too many helpers) has no row: it is a failed activity line, "Could not start a helper: <title>", and its detail is the engine's reason. A `start_task_manager` call likewise reads "Could not start a task manager: <title>" (0.28.1).
- **A helper's model** (step 3a): a quiet label after the title (`pb-helper-model`, 12px `ink-muted`): the model's name and the effort, "GPT-6.1 Terra, high". A helper in fast mode (step 3b) adds "fast" at the end: "GPT-6.1 Terra, extra high, fast". A long title gives way to the label, which stays whole; the row keeps its height and nothing moves when the label is longer. The same label stands after the title at the top of the helper's thread, and the row's name for a screen reader says it ("Helper on GPT-6.1 Terra, extra high, fast").

## The helper's thread

Opening a row shows the helper's thread in the place of the bot's chat, in the same panel, under the bot's own head and tabs.

- **One calm line above it** (`pb-helper-bar`, 40px, aligned with the thread): the way back, named after where it goes ("Po", or the helper above for a helper started by a helper), a small chevron, the helper's title (13px, weight 600, cut with an ellipsis) and the state word at the right ("Working" with the dots, "Finished", "Failed" in `clay`, "Stopped"). Opening puts the focus on the way back. Back returns to the chat at the place where the person was, and the row that was opened has the focus again. The browser's back button does the same, and a reload keeps the thread open.
- **Nothing jumps.** The chat is not drawn again as if it arrived: going back shows every line where it was, with no fade or rise. A thread read for the first time comes in as a whole.
- **The task first** (`pb-msg-task`): the bot gave it, so it sits on the left like a message from a bot, with the bot's face, its name and a quiet "asked the helper". A long task (known from its text, so the first frame has its final height) shows four lines and opens on "Show all"; a shorter one is never cut, also where it wraps to more lines on a narrow phone. In the thread of a helper started by a helper, it carries the helper's mark: "Helper asked this helper". A message the bot sent while the helper worked (`steer_helper`, 0.22.0) looks the same, with the quiet word "sent this while it worked", where it went in.
- **Then the helper's answer**, as in any chat, in the order it happened and live while it runs: its texts, its lines of work and the rows of helpers it started itself, under the helper's mark and the word "Helper" once (`article.pb-answer[data-helper]`), never the bot's face and name. A helper it started itself is a row like any other, and opens one level further. A helper's thread is never folded: it is the place to read the work.
- **While it works**, the thinking line stands at the very end only while nothing is live (a running step is its own live line): the dots and "Working".
- **Where the message box would be** (`pb-helper-foot`): one quiet sentence, "This helper works for Po. Write to Po to change what it does.", and while it works a secondary small button, "Stop helper". It asks first: "Stop this helper?", "Po is told that it was stopped and carries on without its result.", "Stop helper" and "Cancel", Cancel first. When the helper has ended the button keeps its room, out of sight, so the foot does not change height.

## Around it

- A bot whose own turn has ended while its helpers still work is working, never done: its roster line and the pending line read what the engine sends ("Waiting for a helper", "Waiting for 2 helpers"). No badge, no count.
- "Stop" at the message box is offered then too, and stops the helpers ("Stop Po and its helpers" on hover). A message sent then is not held back for the helpers: it starts a turn, so the send button says "Send", not "Queue message".
- "Start fresh now" in Settings is off while helpers work: "Po's helpers are working. Try again when they are done." ("Po's helper is working. Try again when it is done." for one).

## The model it runs on (step 3a)

When the bot chose the helper's model or effort, the row says so.

- **A quiet label after the title** (`pb-helper-model`, inside `pb-helper-head` with the title): the model's name from the list and the effort, joined by a comma: "GPT-6.1 Terra, high". Only the name when no effort was chosen ("Sonnet 5.5"); the model's id when it is not in the list. 12px, weight 500, `ink-muted`, on the title's line.
- **No label** when the helper runs on the bot's own model and effort.
- **The title gives way, never the label**: a long title is cut with an ellipsis before the label; the label stays whole.
- **Nothing moves.** The row keeps its 52px with or without a label, and the title and the line under it stand in the same place either way (the label sits at the top of the title's line, not on its baseline, so the title does not shift by half a pixel when a label comes). A label that arrives later moves nothing else.
- **At the top of the helper's thread** the same label stands after the title (`pb-helper-bar-model`), and the state word keeps the right end.
- The row's name for screen readers says it too: "Try the new picker in a browser. Helper on GPT-6.1 Terra, high, working."

## The provider's mark (step 7a, 14 Nov 2026)

- Where the plain arrow stood on the disc, a helper's row shows the mark of the provider it runs on: Claude's (in `provider-claude`) for a Claude model, OpenAI's (in `ink`) for a GPT model through Codex. The marks are kept in one map in the app (`ui/lib/providers.tsx`), so a new harness adds its mark in one line. When the provider is not known, the plain arrow stays.
