A roster row is one bot in the sidebar: its avatar, its name, one line about what it is doing, and its status mark at the right end.

You provide the bot's initial, name, activity line and state. Mark the open bot with `aria-current="true"`.

- The open bot's row is raised: `surface-raised` with `shadow-raise`. Other rows have no background until hovered, then a `fill` tint.
- The activity line is written by the bot in plain words and fits on one line: "Reading new messages", "Next run Friday 13:00", "Two things need you".
- No unread counts and no timestamps on the row. If something needs the person, the mark is the Waiting mark and the line says what.
- The order of rows is set by the person and does not change on its own. The main bot is first.
- Do not show workers as rows. A bot with running workers says so in its line: "2 workers running".
