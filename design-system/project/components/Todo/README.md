The person's to-do list: things a bot needs him to do or decide that can wait, such as input on a customer task, or an email to send now that the work is done. Added 14 Nov 2026 (step 7c). The person asked: "These are more for action items where I might not need to act right away."

A to-do that leaves the list fades in place over `dur-slow`, then the gap closes over `dur-calm`. With reduced motion the row goes immediately.

**The list ("Your to-do")** stands at the foot of the right rail, under the cards of Needs you and Later today; on a phone at the foot of the Needs you screen. It shares the rail's foot with HelpersAtWork, which stands just above it while helpers work.

- It stays in sight at the foot however many cards wait: the cards scroll under it, behind a soft fade of `ground`. No line, no border. Its own list scrolls inside it past about seven lines.
- One quiet line per to-do: the bot's face at 20 px, the title cut with an ellipsis, and at the right in mono its age ("40 min", "5 h", "2 d") or its "by" day ("by 15:00", "by tomorrow", "by Mon", "by 20 Nov"). A "by" day that has passed reads "was due Thu" in `clay`.
- The ones with a "by" day come first, soonest first; then the newest. A line that is added arrives calmly (`pb-arrive`); a card that arrives above never moves the list. Nothing at all while there is no to-do.
- The head is a side title, "Your to-do", with the count at the right. No notification, no count in the window's title: it is not urgent.
- On a phone the Bots screen's raised row leads to it while only to-dos wait: "Three to-dos for you".

**The window** opens on a click: a Dialog sheet, drawn by Pobots from the bot's blocks, never from HTML.

- Title: the to-do's title. Under it the bot's one line on why, then who it is from and when (face, name, age, "by" day). The window takes the focus itself, so no control lights up on opening.
- The blocks, top to bottom, `space-4` apart: **text** (markdown, 15/24), **facts** (labels muted on the left, values on the right), **a link** (accent text, underlined), **a text to copy** (its label and the quiet Copy button, which says "Copied" in its own width, over the text in a well, scrolling past 240 px), **a picture** (a box of fixed height, 200 px, the picture drawn whole inside it on a sunken well, so nothing moves when it loads; it opens large in a new tab), **a file** (the chip of an attachment; it downloads), **a page** (one of the bot's artifacts as a filled row: its title and "Open beside the chat"), **fields** (short text, long text, a choice as a ChoiceList without hints).
- Under the blocks, a line for a refusal that keeps its room.
- The actions, right-aligned: a quiet "Dismiss" and "Mark done" are always there, then the bot's buttons; its primary button is last, in accent. With fields and no button of the bot's there is one "Send".
- A button sends what the fields hold. The window then closes; the bot gets his answer as his own message, marked "From your to-do: <title>" in quiet type above the bubble. His answer to a card that came back after a restart is marked the same way, "From your card: <title>" (protocol 22, the same `.pb-from-todo` line with `.pb-from-card`).
- A to-do the bot keeps open says under the head when he answered last: "You answered 2 d ago: Looked at them".
- At the foot of the window, under the actions, he can ask the bot about the to-do before he acts (protocol 23, see CardQuestions). The window then keeps its top where it opened, so the thread grows downward only. His question is marked "Question on your to-do: <title>" in the chat.
