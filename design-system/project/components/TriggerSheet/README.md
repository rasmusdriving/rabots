The trigger sheet makes a new trigger. It is the Dialog sheet, opened by "New trigger" on the Triggers tab. A trigger's page uses the same controls to edit it.

You provide the bot. The sheet asks for, in this order:

- **Kind**: Schedule or Webhook, as a segmented control, with one line under it about what each means. The kind cannot change after the trigger is made.
- **Name**: a name for people, "Morning brief", "New ticket".
- **What the bot is told**: a text area, labelled with the bot's name ("What Kaja is told"). For a webhook, one line says that what was sent is added after it, marked as data from outside.
- **When** (schedules only): the schedule picker (see SchedulePicker).
- **Where it runs**: a choice list with a hint on each. "In its chat": runs in the bot's chat, as if you had written it. "As a fresh run": a fresh run starts with a clean head and only reports back if there is something to say.
- "Create trigger" is the one accent button. It waits until the sheet is complete and the schedule is allowed. After it, the new trigger's page opens, where a webhook's address can be shown.

On a trigger's page the same fields are saved with one "Save", since several fields change together. "Put back" undoes what was typed.
