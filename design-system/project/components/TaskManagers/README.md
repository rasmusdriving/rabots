A bot's task managers (16 Nov 2026, protocol 21). A task manager is a helper that owns one long task end to end: it runs workers of its own, may ask the person, and stays until its bot ends it. The person asked: "The orchestrators should live under a section like 'helpers at work' but maybe separated since they are 'orchestrators' or 'task managers' or whatever." And: "the task manager should get their line in the 'main' bot thread like normal too, just that they get their own entry on the right side, sidebar above helpers at work."

**The list ("Task managers")** stands in the rail's foot, just above "Helpers at work"; on a phone on the Needs you screen in the same place.

- The rows are Helpers at work's rows (`pb-atwork-item`), so the two lists read as one family; `pb-tms` on the section and `pb-tms-item` on a row only add what differs.
- One row per task manager that has not been ended, oldest first: the bot's face at 20 px; the title in `ink`; under it the bot's name and what it does now in `ink-muted`: "Kaja, 2 workers", "Kaja, working", "Kaja, waits for you" (in `ink`, it needs the person) or "Kaja, resting". At the right the thinking mark while it works, the waiting mark while a card of it waits, and in mono how long it has run.
- The second line changes in place (`pb-fade-in`); the row keeps its box.
- A click opens its thread, going to its bot first; on a phone the bot's chat screen with the thread open.
- A row arrives calmly (`pb-arrive`); an ended one folds away where it stood (`dur-calm`). Nothing at all while there is none. No "N more": a bot has at most four.

**Its thread** opens in the place of the bot's chat, as a helper's does.

- The head is the helper bar: back to the bot, the title, the model, and its state in a word ("Working", "Waits for you", "Resting", "Ended"). On a phone the model moves to the start of the settings line (`pb-tm-model`), so the title keeps its room.
- Under it one quiet line of its settings in `ink-faint`, 12 px: workers at once (and how many now), its tools in words ("Workers, Questions to you, Notes to you, To-dos, Messages to bots, Pages, Browser"), whom it may message, and its folder in mono when it is not the bot's own. The parts wrap; each part's dot is clipped away when it starts a line.
- The bot's task is "asked the task manager"; its own words are headed "Task manager". Its workers stand in its thread as helper rows; a worker opened from the rail opens inside it, so back leads to the task manager.
- At the foot a message box (`pb-composer`, Enter sends, on a phone Enter adds a line) and under it the helper foot: "Works for Kaja.", a quiet "Stop" while it works (kept in place, out of sight, while it rests, so the foot keeps its size) and "End task manager". Both ask first. Once ended: one line, "This task manager has ended. Kaja can start a new one."

**What it raises** says whose it is: a card's head reads "<task title>, for <bot>" with the bot's face, and what it asks on the line under it ("Needs a choice", "Asks for permission, for its worker Draw the form"). A to-do's window says the same in its "from" line. In "Helpers at work" its worker reads "Kaja, for Build the booking page".

**Its row in the bot's chat** is a helper row whose word is its state; it opens the same thread.
