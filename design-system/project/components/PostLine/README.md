The post line marks, in a bot's chat, a post the bot wrote in a channel on its own with `post_to_channel` (15 Nov 2026, engine 0.23.0). It is an ordinary quiet notice line (`app-notice`, `data-mark="posted"`) that carries the post behind a button.

- **Posted**: "Posted in Ops - Internal" in `ink-faint`, the time in mono, then a quiet button "Show the post" (`pb-notice-btn`, 12px, weight 500, `ink-faint`; hover and open in `ink-muted`). It opens the post itself as markdown in a well below the line (`pb-notice-post`, `surface-sunken` with `shadow-well`, `radius-lg`, set in from the left as far as the line), and reads "Hide the post" while open. Closed by default.
- **Could not post**: the error notice (`app-notice-error`, the blocked mark, `ink-muted`) with a short reason and the next step: "Could not post in Ops - Internal: no answer in time. Check the channel before posting again", "...: the flow needs its branch for new posts", "...: the flow failed. See its run history", "...: the flow said no. Check the address for answers", "...: the flow could not be reached". It carries the post behind the same "Show the post".

Rules:

- **The line keeps its place.** Opening the post adds the well below it; the line does not move and the chat is not scrolled. The well fades in over `dur-quick` without travel.
- **It comes at the end of the bot's turn**, as the main bot's change lines do, so it never splits the bot's answer. The bot's own activity line ("Posted in Ops - Internal", its text as the detail) stands in its work at once.
- With the keyboard "Show the post" is one of the chat's line buttons (one Tab stop for all of them, Up and Down between them), with the 2px focus ring.
- The post can be long (up to 4,000 characters): the well wraps long words and never makes the chat scroll sideways.

**Calendar lines (16 Nov 2026).** A calendar action leaves the same quiet line (`data-mark="calendar"`) at the end of the bot's turn: "Created Nordvik report (Thu 19 Nov 08:00)", "Moved Weekly sync to Fri 20 Nov 13:00", "Cancelled ...", "Accepted ...", "Tentatively accepted ...", "Declined ...". Its button reads **Show the details** / **Hide the details** and opens the meeting's lines as plain text, one per line (`pb-notice-post[data-plain]`, never markdown). A failed one is the error notice: "Could not move Weekly sync: no answer in time. Check the calendar before trying again", with the same details behind the button.
