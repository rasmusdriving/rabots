The fresh start line marks the place in a bot's chat where its working session starts over. The chat the person sees is one thread for good; behind it the bot works in a session that Pobots replaces with a fresh one at calm moments, after the bot has written down what matters (docs/context.md). The line lets the person see at a glance, when scrolling back, where the bot's working memory begins.

It has two states in one box (`pb-fresh-wrap` holding `pb-fresh`):

- **Pending** (`data-state="pending"`, `pb-fresh-pending`): while the bot writes down what matters, a quiet rule across the thread with the bot's small face (18px, working) and "Writing down what matters" in the middle, as a status. It stands in the place of the tidy turn. It is not a message and not the pending line of an answer (`pb-pending`), which never shows during a tidy turn: the bot is not answering the person.
- **Started fresh** (`data-state="done"`, `pb-fresh-btn`): the same rule with "Started fresh · 14:52" in `ink-faint`, the time in mono, "Yesterday 14:52" or "3 Nov 14:52" when it is not today. A button: it opens below itself, in a well (`pb-fresh-body`), one sentence that says what this is ("Po wrote this down for itself before starting fresh. The chat above is still there for you, and Po can search it."), the bot's note as markdown (`pb-fresh-note`), and under it the steps of the tidy turn (the memory files it wrote) as the usual quiet activity lines (`pb-fresh-steps`). Closed by default.

Rules:

- **Nothing moves when it changes.** Both states have one fixed height (28px) and the same rule, so turning from pending into "Started fresh" only swaps the words. The words fade in over `dur-quick` without travel (`pb-fade-in`). The box is the same element in both states, so it does not arrive twice. If the engine says the tidying is over a moment before its "fresh" notice comes, the pending words stay until it does.
- **The tidy turn is never drawn as messages.** Pobots' request that starts it, the bot's note as a message and its steps show only inside the opened line. A tidy turn that fails or is stopped leaves nothing in the chat.
- **It stays at the place of the tidy turn.** A message the person sends while the bot is tidying waits below the line, queued, and then runs in the fresh session.
- **The rule is the `divider` token**, a 1px fill inside the thread on both sides of the words, never a border. It is the one place the thread uses `divider`.
- **Quieter than a message, clearer than a notice.** 12px, weight 500, `ink-faint`; hover and open in `ink-muted`.
- With the keyboard it is one of the chat's line buttons (one Tab stop for all of them, Up and Down between them), with the 2px focus ring. Opening it keeps the line where it is.
- Nothing of this scrolls the chat or takes the focus when it happens while the person reads or types.

A **compacted** notice ("The session was nearly full, so it was shortened in the middle of this task") is an ordinary quiet notice line, not a fresh start line: the session went on, shortened by the harness in the middle of a long task.
