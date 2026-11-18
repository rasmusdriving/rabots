The trigger list is the Triggers tab of a bot's page: what wakes the bot by itself.

You provide the bot's triggers. Each is one soft row with a switch on the right.

- **Row** (`pb-trigger`): the name, when it runs in plain words ("Weekdays at 07:30", "Every 30 minutes, 08:00 to 17:00, weekdays", "Once on Friday 14 Nov at 13:00", "When its address is called"), then one small line: how the last run went (its mark, word and time) and, after a middle dot, when it runs next ("Next tomorrow 07:30", "Waits for a call", "Switched off").
- A trigger the bot made itself says so quietly beside the name: "Made by Inbox" (`pb-trigger-by`).
- The row opens the trigger's page. The switch turns it off and on and saves at once. A switched-off row keeps its place; its name and when-line turn `ink-muted`.
- The row's parts keep their places, so a run finishing or the switch turning only changes words. Nothing in the list moves.
- Run marks are the existing ones: done is the quiet check, running the working mark, failed the blocked mark, skipped the idle ring, nothing to report no mark (an empty space the same size, so the words line up).
- "New trigger" is a quiet secondary button in the bar above the list. It opens the trigger sheet (see TriggerSheet).
- With no triggers: one line that says so and, in one sentence, what a trigger is for.
- Keyboard: the row and its switch are two tab stops. Both show the focus ring.
