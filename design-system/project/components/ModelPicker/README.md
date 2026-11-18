The model picker chooses a bot's model and effort in one small floating panel.

It opens above the composer when the model text is pressed, and from a bot's card. Models are on the left with a search line and key hints. Effort for the chosen model is on the right. The foot shows the machine and the access level as quiet buttons that open their own menus.

You provide the list of models, the effort levels of the chosen model, and the current choices.

- The panel is `surface-overlay` with `shadow-float` and `radius-lg`. It has no border. The effort column is set apart by a `fill` tint, not a line.
- An option is one line of text. The chosen one has a `fill` tint and a check. Nothing else is highlighted.
- Key hints (`pb-key`) are shown for the first models only. They are a help, not decoration.
- Choosing a model keeps the panel open so effort can be set. Choosing an effort closes it. Escape closes it without a change.
- The panel arrives with `pb-arrive` and leaves in `dur-quick`.
- Use the same panel shape (`pb-pop` with `pb-option` rows) for every other menu in the app.

## Two kinds of models (step 3a)

A bot runs on a Claude model or on a GPT model. The list is one list in two groups, in the order the engine sends it: "Claude", then "ChatGPT".

- Each group has a quiet heading (`pb-picker-group`): 12px, weight 500, `ink-muted`, never focused and never an option. Arrow keys walk from the last Claude model straight to the first GPT model.
- With only one kind in the list there are no headings: the picker looks as before.
- Key hints stay on the first four models of the list. A search keeps the heading of each group it keeps.
- The person reads the model names and the two group names. "Codex" is named only where the program itself is the subject (not installed, not signed in, which program runs a bot). Never "harness", "provider" or "sandbox".
- **When Codex is not ready**, no GPT model is offered, except the one the bot is on now, so its choice still shows. The picker above the composer says nothing about it. In "Add a bot" and a bot's settings one quiet `pb-hint` line under the choices says why, with the engine's sentence ("Codex is not signed in. Run codex login in a terminal on the Mac."). Never a warning: it is no fault.
- **The same groups as rows of choices** (`pb-model-groups`, `pb-model-group`, `pb-model-group-title`) in "Add a bot" and in a bot's settings: one `pb-seg` row per group under a small heading; one row and no heading with one kind.
- **Said before the choice** (after the tester): where an existing bot's model is chosen (the picker above the composer, the settings), the heading of the group the bot is not on carries a quiet second part, `pb-group-note`: "ChatGPT  starts a fresh session" for a bot on Claude, "Claude  starts a fresh session" for a bot on GPT. Weight 400 in `ink-faint`, on the heading's own line at its height; the heading never wraps (the words give way with an ellipsis first), so nothing moves when the bot changes side and the words change heading. The bot's own group stays plain, and so do both headings in "Add a bot". For a screen reader the group's name (and in the picker each option's name) includes the words.
- **Changing between Claude and ChatGPT** in the settings: at the moment of choosing, one quiet line under the choices: "Changing between Claude and ChatGPT starts a fresh session. The bot keeps its memory and gets the end of the chat." No dialog. While the bot works the engine refuses, and the refusal takes the change line's place under the choices, in `clay`: "Wait until the bot is done, then change its model." It is not said beside the section title, where a long sentence can wrap in a narrow column and move the page. The picker above the composer shows the same sentence where its errors go.
- **Which program runs it**: a bot on a GPT model says so under the choices in its settings: "Runs on Codex with your ChatGPT login."
- The line under the choices (a refusal, else the change line, else why ChatGPT is missing, else which program runs the bot) stands in a box that keeps its height whichever line it shows, or none (`pb-model-note`: every line it can show sits in the same place, only one of them seen). Nothing below it moves when a line comes or goes.

## Fast mode (step 3b)

A model may have a fast mode: it answers faster, on some models for more of the plan's usage. Today only the GPT models have one; which do is read from the engine's list, never written into the app. A bot's choice is on unless switched off, and it is kept when the model changes.

- **One switch named "Fast"**, the quiet switch (`pb-switch-quiet`, see Field), beside the effort choice in the three places where a bot's model is chosen, and only while the chosen model has a fast mode. Beside its name stand the model's own few words about it ("1.5x speed", "2x speed, increased usage") in the manner of the note "Default" on an effort; with no words, nothing stands there. The words are said to a screen reader as the switch's description.
- **As quiet as an effort option**: the same type size, weight and ink as an effort in that place, and no colour when it is on. On is told by the knob's place and the track turning from a tint to the grey of a check mark, never by `accent`.
- **In the picker** it is the last row of the effort column (`pb-fast-option` in `pb-fast-room`): the name and the switch on one line, the words under the name, because the column is narrow. It saves at once and the picker stays open; an error shows where the picker's errors show. The arrow keys walk the efforts and reach it at the end of the column; Space and Enter switch it. Choosing an effort still closes the picker.
- **In a bot's settings** it stands on its own line under the efforts (`pb-effort-line` holding the efforts and `pb-fast`), saved the way effort is saved ("Saved" beside the title). Off, its name has the ink of an effort not chosen; on, the ink of the chosen one.
- **In "Add a bot"** it stands on the line of the label "Effort", so the sheet is no taller for it. It is on by default and sent with the new bot.
- **Nothing moves.** While any model in the list has a fast mode, the switch keeps its room in all three places, also for a model without one (then it is out of sight and out of reach), and the room for its words is as wide as the longest words of any model offered (`pb-fast-hints`). So nothing changes place or size when the switch comes, leaves, gets other words or is switched, and the switch itself never changes width. With no model with a fast mode in the list there is no switch and no room.
- Changing to a model without a fast mode hides the switch and does not change the choice; changing back shows it as it was.
- **The model button of the message box** says it after the effort: "GPT-6.1 Terra  Extra high, fast", for a model with a fast mode while the switch is on, and as before otherwise. Its name for a screen reader says it too.
- The words are "Fast" (the switch) and "fast" (in a label). Never "service tier" or "priority".
