Every helper that works now, across the bots (16 Nov 2026). The person asked: "Okay so here i am having a hard time finding the helper a bot is waiting on? Could we make it so that the todo list section also lists active workers/helpers?"

**The list ("Helpers at work")** stands in the rail's foot, just above "Your to-do"; on a phone on the Needs you screen in the same place.

- The foot holds both lists and stays in sight at the foot of the rail, as "Your to-do" alone did: the cards scroll under it, behind a soft fade of `ground`. It grows upward into the free space, so Needs you and Later today never move when a helper starts or ends.
- One row per helper, oldest first, so a new one comes at the end and nothing moves: the bot's face at 20 px; the helper's title in `ink`, under it whose it is in `ink-muted` ("Kaja", or "Onboardings, in Morning work round" when the helper works for a fresh run); at the right the provider's mark (the same map as the Helper row: Claude's in `provider-claude`, OpenAI's in `ink`) and in mono how long it has worked ("now", "4 min", "1 h 5 min"), brought up to date every 30 seconds in its own small span.
- Three rows, then a quiet "2 more" that opens the rest in place, and "Show less". Rows are at least 44 px high.
- A click opens the helper's thread, the same one its row in the chat opens, going to its bot first; on a phone the bot's chat screen with the thread open.
- A row arrives calmly (`pb-arrive`); a row that ends folds away where it stood (`dur-calm`). Nothing at all while no helper works.
- The head is a side title, "Helpers at work", with the count at the right.

**The waiting line.** When a bot waits for helpers, its "Waiting for a helper" line under the chat becomes a quiet button in the same box, its words underlined in `divider`.

- It says how many, and where when they all work for one fresh run: "Waiting for a helper in Morning work round".
- One helper: a click opens its thread. Several: their rows in the chat are brought into view and marked for a moment in `accent-soft`; when their rows are not in this chat, the rows of "Helpers at work" are marked instead (opened when behind "N more"), and on a phone the Needs you screen opens.
