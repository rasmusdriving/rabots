The runs of one trigger, newest first, on the trigger's page.

You provide the runs. Each row shows:

- **The status mark and word**, with the existing marks only: done is the quiet check, running the working mark, failed the blocked mark (and its word in `clay`), skipped the idle ring, nothing to report no mark. The words are "Done", "Running", "Failed", "Skipped", "Nothing to report".
- **The note** under the word, on one line: the first words of the result ("Nothing was passed on to the chat" for a run with nothing to report), why it was skipped ("Pobots was not running at 07:30", "The last run was still going") or what went wrong. A running run says "On it now", or "Waiting its turn" before its turn starts.
- **When**, in `mono-small`: "Just now", "12 min ago", "07:30", "Yesterday 16:30".

Every row is two lines high whatever its status, so a run that finishes changes words in place and the list never moves. A new run is added at the top.

A run opens what happened, in place:

- **A run in the main chat**: the whole note and a quiet "Show in chat", which opens the Chat tab at that turn.
- **A fresh run**: its own thread, read-only, on a raised card (`pb-run-thread`), built with the same message components as the chat (see Message).
- A run that never started (skipped) has nothing more to show, so its row is not a button.

"Show earlier runs" reads the next page.
