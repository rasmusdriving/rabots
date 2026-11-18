What came in on a channel and what became of it, newest first, 20 at a time with "Show earlier messages".

- **Row** (`pb-cmsg`): the status mark, then two lines: the writer (weight 500) with quietly where it went ("to Kaja" when the tag is the bot's name, "tagged Inbox, to Onboardings" when not), and the status word with the note after a middle dot; when on the right.
- **Words and marks**, the existing marks only: Delivered (the working mark; the bot has it or it waits in line), Answered (the quiet check), No answer (no mark, `ink-muted`), Answer not posted (the blocked mark, word in `clay`), Refused and No tag matched (the idle ring, `ink-muted`).
- Every row is two lines whatever its status, so a message going from Delivered to Answered only changes words. A new message is added on top; nothing below it moves after that.
- A message that became a turn in a bot's chat opens in place to its note and "Show in chat", which opens that bot's chat with the turn in view. A message that never reached a bot (refused, no tag matched) has nothing more to show, so its row is not a button.
- With none: "Nothing has come in yet. Messages show here once the flow posts them."
