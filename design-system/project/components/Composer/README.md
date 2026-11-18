The composer is where the person writes to a bot: a raised, rounded box with as little in it as possible.

It holds four things and no more: the text line, an add button on the left, the model as quiet text on the right, and the round send button. Pictures and files the person attached stand in a tray above the text while there are any (see Attachment).

You provide the bot's name for the placeholder ("Message Kaja") and the current model and effort ("Opus 5.5 High"). For a model with a fast mode while the bot's switch "Fast" is on, the effort says it: "GPT-6.1 Terra Extra high, fast" (see ModelPicker).

- The box is `surface-raised` with `shadow-raise` and `radius-xl`. It has no border and no focus outline of its own; the caret shows where you are.
- The placeholder is the only instruction. No helper text, no character count, no row of chips for anything but what is attached.
- The add button, "Attach pictures or files", opens the system's picker of files. A screenshot pasted into the text becomes a picture in the tray; pasted text is text, as always. Files dropped anywhere on the chat join the tray too.
- A message may be pictures and files with no text. While a file uploads, Send waits on the button (a little quieter, the same size) and the message goes by itself when the upload is done.
- The model text opens the model picker above the composer. Access level and machine live in that picker and on the bot's card, not in the composer.
- Enter sends. Shift and Enter adds a line. The box grows up to six lines, then scrolls.
- While the bot is working, sending does what Pobots settings says under "When a bot is working" (steering, 13 Nov 2026, after T3 Code's follow-up behavior): **Steer** (the default) puts the message into what the bot does now, and it reads it at its next step; **Queue** lets it wait until the bot is done. The send button says which: "Steer message" with the send arrow, or "Queue message" with the queue mark (lines and an arrow to the end), in the same place and size; its tooltip on a computer names the other way ("Steer message · Ctrl+Enter to queue"). An idle bot's button is plain "Send".
- The other way for one message: Ctrl+Enter (⌘+Enter on a Mac) or a Ctrl-click on the send button on a computer; on a phone, holding the send button for `dur-hold`. A held press sends at once while the finger is still down; the button stays the send button until the finger is lifted, so the lifting finger never presses Stop. Nothing else in the composer changes.
- A queued message waits with a line above the composer: "Queued, Kaja will read this next". After a Stop a queued message waits until the person writes again, and the line says so: "Queued, Kaja will read this when you write again". A steered message has no such line; its own note says "Steered" (see Message).
- To stop a bot, the send arrow becomes a stop square while it works and the box is empty.

## Waiting messages (step 7a, 14 Nov 2026)

- Messages that wait for the bot stand in a stack right above the message box, oldest first, at the right like the person's own messages, their words in `ink-muted` on `fill`, cut to three lines until pressed. A message from a trigger, another bot or a channel says who it is from above it.
- Under each of the person's own: "Steer now" while the bot works, and a quiet × that takes it back ("Remove this waiting message"). More than three: the first two show, and "Show all 4 waiting".
- "Queued, Kaja will read this next" stands at the foot of the stack, right above the box.
- When the bot takes a message it leaves the stack and stands in the chat where it was read, gliding there from its place in the stack over `dur-quick` (still with reduced motion). The message box does not move.
