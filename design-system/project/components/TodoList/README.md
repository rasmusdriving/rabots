The bot's own to-do list beside its chat (step 7a, 14 Nov 2026): the plan its harness keeps while it works (Claude's task tools, Codex's plan), so the person sees where the bot is in a long piece of work.

- It shows while the bot works, and while the list has steps that are not done.
- Where the chat leaves room beside its text (a chat wider than about 1100px), it floats at the top right of the chat as a quiet raised card (`surface-raised`, `shadow-raise`), never over the text: "To-do" and "3 of 7" on one line that folds the list away, then each step with its mark. It never moves the chat.
- Otherwise, and always on a phone, it is one line above the chat: a chip with "3 of 7" and the step now, which opens the list over the chat (`surface-overlay`, `shadow-float`); Escape or a press elsewhere closes it.
- Marks: done is a check on `fill` with the words in `ink-faint`; doing is a ring in `accent-text` with a dot that breathes (`dur-breath`), the words in `ink`; to do is a ring in `track`, the words in `ink-muted`. Each step also says its state to screen readers.
- It updates in place: a step that changes keeps its row; the count fades to its new number.
- Words: "To-do", "3 of 7". Codex's own few words about its plan, when it gives some, stand above the steps in `ink-muted`.
