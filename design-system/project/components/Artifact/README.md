An artifact is a page a bot made for the person to look at or use: a report, a mock-up, a chart, a status page. It is a thing to open, not a line of work. In the chat it is one row; opened, it shows beside the chat in a panel of its own, the way Claude shows an artifact beside the conversation. A bot's page lists them in an "Artifacts" tab.

The word is always "artifact" in anything the person reads. Never "page", "preview", "canvas" or "file", except where the text is about the file itself ("The file is gone").

There are two kinds. A **page** is an HTML file in the bot's folder, shown inside Pobots in a sealed frame; it may also have been published to Claude and then has a link. A **link** lives only on Claude (a document, a deck, a page of one of Claude's own types). Claude's pages refuse to be shown inside another page, so a link opens in a window of its own beside Pobots.

## The row (`pb-artifact`)

One button, at its place in the bot's answer, from left to right:

- **The mark** (`pb-artifact-mark`): a small drawn page with a folded corner on a soft `fill` disc; for a link, a page with an arrow leaving it. Never a face. While the artifact is open beside the chat, the disc takes `accent-soft` and the mark `accent-text`: the one small sign of where it is.
- **The title** (`pb-artifact-title`), in `ink` at weight 600, 13px, cut with an ellipsis.
- **One muted line** (`pb-artifact-line`), 12px `ink-muted`: what happened and when, in a few words. "Made 14:02", "Updated 14:10", "Published to Claude 14:12". For a link, where it lives too: "Made 14:02 · On Claude, opens in its own window". When the file is gone: "The file is gone". When it was taken off the list: "Taken off the list". Said once here and nowhere else; no apology, no explanation of frames.
- **Where it opens** (`pb-artifact-go`): a window with its right part marked (opens beside the chat), or an arrow out of a box (opens in its own window). Nothing when it cannot be opened.

Rules:

- **One fixed height (52px) in every state.** When the file goes or comes back, or the artifact is published, the words change in place and fade in; nothing above or below moves.
- **Raised, and no wider than a card** (`surface-raised`, `shadow-raise`, `radius-md`, at most 440px). A helper's row is flat and as wide as the answer: work. An artifact's row is a thing that sits on the answer: told apart at a glance.
- **It shows the newest state** the app knows for its artifact (from the bot's list and every change), not the copy in its line: the title, the link, whether the file is there.
- **Part of the answer, not of the work.** When a finished turn folds its work into "Worked for", the artifact rows stay in sight with the answer, in their order. In a turn that still runs, the row arrives where the bot showed it, and the thinking line stands below it while nothing is live.
- **One row per artifact in a turn**: when a bot made a page and published it in the same turn, the turn shows one row, the newest, at the place of the first.
- A page opens in the panel; a link opens in its window. A row that cannot be opened is quiet (its title in `ink-muted`) and does nothing; it stays a line.
- It is one of the chat's line buttons: one Tab stop for all of them (the newest), Up and Down between them, the 2px focus ring, Enter opens it. Escape on the row of the open artifact closes the panel; the focus stays on the row.

## The panel (`pb-artifact-pane`)

- **Where.** In the place of the "Needs you" rail, beside the chat, as a reading panel of its own: `surface`, `radius-xl`, `shadow-panel`. While it is open the rail is not shown; it stays laid out underneath, out of sight, so nothing in it arrives again when it shows.
- **Width.** About half of the space beside the roster by default. Never narrower than a readable minimum for either side (the chat 400px, the panel's column 380px). The line between chat and panel (`pb-artifact-divider`, `space-3` wide) can be dragged and moved with the arrow keys (Left wider, Right narrower, Home widest, End narrowest); its grip, a small `fill-strong` pill, shows on hover and focus only. The width is remembered on this device.
- **Fill.** One control makes the panel fill the whole main area, the chat hidden behind it, and back. When the window is too narrow for both, the panel takes the place of the chat with a way back named after the bot, like a helper's thread; the way back has the focus.
- **The chat keeps its place.** Opening, closing, filling and making the panel wider or narrower change the chat's width only. When the panel opens or closes, the artifact's row stays where it is, if it is in view; otherwise, and when the panel is made wider or narrower, the line at the top of the visible chat stays the line at the top, at the same height. Nothing scrolls by itself.
- **The top line** (`pb-artifact-bar`, 56px): the title over one muted line ("Made 14:02", "Updated 14:10"; it fades in anew when the page changes), then, when cards wait, a quiet "Needs you 2" with the waiting mark (it closes the panel and shows the rail; a new card changes the number in place and never closes the panel by itself), then the small controls at the right: "Load again", "Open in a new tab", "Open on Claude" (when it has a link) or "Publish to Claude" (when it has none), "Narrower" and "Wider", "Fill the main area" or "Show the chat beside it", "Close". They are icons with their words on hover and for screen readers, like close; this is the one place where controls go without a visible word, because the artifact needs the room.
- **The page** runs in a frame that fills the rest: a sandbox without `allow-same-origin` and without `allow-top-navigation`, no referrer, a title for screen readers. The window never reads from the frame or writes into it. The frame stands on `frame-ground`, a plain light ground, the way a browser tab starts.
- **Loading.** A new frame loads out of sight; the panel shows "Loading the artifact" in `ink-muted`, only after a moment (`dur-slow`), so a page that loads at once never flashes it. If it cannot be had (asked once more first): "This artifact could not be loaded" with "Load again".
- **When the bot changes the page**, it loads again by itself: the new version loads out of sight under the one shown and takes its place once it has loaded. The panel is never empty, nothing flashes. "Load again" does the same.
- **Escape** closes the panel when the focus is in it (not inside the page itself, which keeps its own keys) or on its row; the focus goes back to the row it was opened from. Opening another artifact swaps the panel's content. The panel stays open across the bot's tabs and when a helper's thread is opened, closes when another bot is chosen, and a reload keeps it open.
- It arrives with a plain fade over `dur-calm`, no travel. Closing is at once.

## On Claude

A link, and "Open on Claude", open the page in a separate browser window placed at the right edge of the screen, the same named window each time so it is reused. When the browser blocks the window, a small dialog offers the link as a plain link to click. In the desktop window, it opens in the system's browser like other outside links.

This holds also when the bots' browser can be reached. For a while (step 2g) a link opened in the person's own page in the browser panel instead; the live picture was not sharp enough for reading a document, so since step 2g's third round it opens in its own window again, and the row's line reads "On Claude, opens in its own window" in every case. Nothing in the app opens a page on Claude in the browser panel by itself; the person can still type or paste any address in "Your page" there.

## Publishing

"Publish to Claude" asks first: "Publish this to Claude?", "Po puts this artifact on Claude and gives you a link to share. It stays private there until you share it.", "Cancel" (first) and "Publish". Yes sends the bot an ordinary message from the person: `Publish the artifact "<title>" to Claude and give me the link.` The bot does it in its chat. While the bot is in a turn the control is off, with the reason on hover: "Po is working. Try again when it is done." Nothing else in the app publishes.

## The Artifacts tab (`pb-artifact-list`)

After "Files". One line per artifact, newest change first: the mark, the title (14px, 600), and one muted line with where it lives and when it changed: "In Pobots · Updated 14:10", "On Claude · Made 09:33", "In Pobots · On Claude · Updated 09:25", "In Pobots · The file is gone". The line opens it (beside the page, or in its window); the one open is marked like its row. At the right two quiet buttons: "Show in chat" (the chat, scrolled to the artifact's newest row, which takes the focus) and "Remove from the list", which asks first: "Remove this artifact from the list?", "The file stays in Po's folder, and anything on Claude stays on Claude. Its lines in the chat stay too.", "Keep it" and "Remove from the list". Kept up to date by every change. With none: "No artifacts yet. Ask Po to make one, for example a status page or a mock-up."
