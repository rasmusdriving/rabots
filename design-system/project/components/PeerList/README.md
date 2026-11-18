The peer list says which other bots a bot may message: each bot with its face, name and purpose, and a switch.

You provide the other bots and which are allowed.

- The main bot is always reachable, so its row says "Always" instead of a switch.
- On the main bot's own settings there is no list, only the line "Kaja is the main bot, so it may message every bot."
- Each switch is named as a fact for screen readers: "May message Onboardings".
- Changes save at once; "Saved" shows beside the heading for a moment.

**May steer** (0.22.0) is a section of its own right after the peer list: one row, "May steer other bots", with what it means beside it in a quiet hint ("On: Onboardings can send a message into a bot's running turn, which reads it at its next step. Off: its messages wait until the other bot is free.") and a switch named as a fact (`pb-steer`, `pb-switch`). Off by default. On the main bot's own settings there is no switch, only the line "Kaja is the main bot, so it may steer every bot." Under both, quietly: "Every bot can always steer its own helpers." It saves at once with "Saved" beside the heading, in the same box.
