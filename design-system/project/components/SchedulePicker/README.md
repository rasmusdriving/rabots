The schedule picker sets when a trigger runs, with plain controls and no syntax. It sits in the trigger sheet and on a trigger's page.

You provide the schedule. The picker shows it and says what it means as it changes.

- **Three plain choices** in a segmented control: "At a time", "Every", "Once".
- **At a time**: a time and the days. **Every**: a number with Minutes or Hours, optional From and To times, and the days. **Once**: a date (chosen from a list of the coming days, never typed) and a time.
- **Times** are typed the way people say them and tidied when you leave the field: "7", "730" and "7.30" all become 07:30. They are set in `font-mono` in a narrow well (`pb-time-input`).
- **Days** (`pb-days`): seven toggles in a well, any number chosen. A chosen day is `accent-text` on `accent-soft`, like a chosen option. Two quiet shortcuts beside them: "Weekdays" and "Every day".
- **The sentence** (`pb-sched-say`) under the controls says the result: "Runs weekdays at 07:30. Next: tomorrow 07:30". It changes in place as you change the controls.
- **Not allowed** is said in the same place, in `clay`, in plain words: "Runs must be at least 5 minutes apart.", "Choose at least one day.", "That time has passed. Choose a later one." Saving waits until it is fine.
- A trigger that is switched off never promises a next run: "Runs weekdays at 07:30. It is switched off, so it will not run." A "once" that has had its time and switched itself off is not a mistake, so it is said calmly, not in `clay`: "This time has passed and the trigger is switched off. Choose a later time to run it again."
- Times are the machine's own local time. The engine keeps the real next time; the picker only shows a preview.
- A select (`pb-select`) is a well like an input, with a small drawn chevron. No border.
