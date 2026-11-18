The activity day is the settings window's last section, **Activity** (17 Nov 2026, engine 0.30.0): one day of what happened in Pobots, read only, from the same reading as the main bot's `activity_log`. Times and labels only, never what was written. It is built like Usage beside it, as T3 Code lists its read-only Diagnostics page among its settings.

- **Title and line**: "Activity" (`pb-section-title`), then the quiet line "What happened in Pobots on a day, with times. Labels only, never what was written."
- **The head** (`pb-actday-head`): the back arrow **Previous day**, the day's name in a fixed room (`pb-actday-name`, 14px, weight 600: "Today", "Yesterday", "Mon 16 Nov", with the year when it is another year), the forward arrow **Next day** (dimmed in `ink-faint` on today), and at the right a quiet small **Today** (its room kept, hidden, on today). The arrows are the page arrows (`pb-icon-btn`, 32px; 44px on a phone), named by their labels.
- **Read line**: "Read at 14:02." with **Refresh** (`pb-set7-checked`, as Usage), "Reading now." before the first read, "Reading the day." while another is read. When the engine's time zone is not the browser's, the line adds "Times in Europe/Stockholm."
- **Summary** (`pb-actday-summary`, 13px, `ink-muted`): "You were active from 08:02 to 11:40: 34 minutes over 2 blocks." (or "Your one action was at 09:15.", "No actions of yours."), then the counts: "3 actions, 5 bot turns, 1 helper, 1 calendar action, 1 channel post." Only counts above nought.
- **Rows** (`pb-actday-row`, 14px), in time order: the time in mono (`font-mono`, 13px, `ink-muted`), with "to 08:30" under it in 12px `ink-faint` when it lasted a minute or more; then who, weight 500 ("You" in `accent-text`, or the bot's name), and the words, the tool's own: "Message to Po, from a computer, chat "Planning the week"", "Worked, started by schedule "Morning round", 2 turns", "Helper "Check the import" (Haiku 5.5, low), done", "Made the meeting "Weekly sync" for Wed 18 Nov 09:00, done", "Wrote a post in channel "Ops - Internal", posted". No lines between rows (house rule): a small gap. On a day the clocks change each time carries its offset ("02:30+01:00") and the time column is wider.
- **A quiet day**: one line, "Nothing happened in Pobots on this day." A very long day ends with "12 more rows are not shown."

Rules:

- **Nothing jumps.** The head keeps its size and place whatever the day: the name has a fixed room, Today keeps its room when hidden. Changing day names the new day at once; the old rows stay, faded to 0.6 over `dur-quick`, until the new day is in; then the list starts at its top. Nothing else moves.
- Read only: no setting, nothing collected for it. Po reads the same day with `activity_log`.
- Long titles wrap (`overflow-wrap: anywhere`); nothing scrolls sideways at 360px.
- The styles are `ui/activity.css` in the app (tokens only); the preview carries a copy of them.
