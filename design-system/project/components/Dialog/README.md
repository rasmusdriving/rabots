A dialog floats over the app on a dimmed layer (`scrim`) on the overlay surface. There are two kinds: a sheet that holds a short form, and a confirm that asks one question.

You provide the title, the text or the form, and the two answers.

- Sheet (`pb-dialog pb-dialog-sheet`): adding a bot: name, purpose, its job, the model in two groups, the effort of the chosen model (its default first; it follows the model, and an effort the new model lacks falls back to that model's default), access. The effort row stands in `pb-effort-box`, which keeps the height of the longest row, so the sheet never changes height when the model changes. For a model with a fast mode the switch "Fast" (see ModelPicker) stands on the line of the label "Effort", on by default; for a model without one it keeps its room there out of sight, so the sheet is no taller for it and nothing moves. The title is set as `title`. One primary button says what happens ("Create bot"); "Cancel" is quiet.
- Confirm (`pb-dialog`): "Retire Inbox?", "Remove memory/topics/customers.md?", "Undo this change?", "Leave without saving?". The text says what will happen and what is kept. The confirming button names the action; the other names staying ("Keep it", "Keep editing").
- A confirm that removes something uses the danger button on a `clay-soft` tint, so it reads as a button on its own. Focus starts on the safe answer.
- The dialog arrives with `pb-arrive`; the dimmed layer fades in. Nothing slides in from an edge.
- Focus stays inside while it is open. Escape and a click on the dimmed layer close it, and focus goes back where it was.
