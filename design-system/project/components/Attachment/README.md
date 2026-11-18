Pictures and files the person gives a bot with a message: in the message box before they are sent, in the chat after, and a picture opened large.

The words are "picture" and "file", never "attachment" in the interface, "upload" only for what is on its way ("Uploading", "didn't upload").

**In the message box: the tray** (`pb-tray`). It stands above the text inside the composer, only while something is attached.

- It is one row of chips (`pb-tray-chips`) and one quiet line under it (`pb-tray-line`). The row has one fixed height (60px, with room for a thin scrollbar) and scrolls sideways when the chips do not fit; the line is one line of `label` size. Neither ever changes height while chips upload, fail or finish. Adding the first chip grows the composer once, the way a second line of text does, and the chat above keeps its place at the bottom. Removing the last one takes the tray away again.
- A chip (`pb-chip-file`) is a soft `fill` square of `radius-md`, 48px tall: the picture's thumbnail (made in the page from the file) or a drawn sheet for a file in a `fill-strong` square, the name, one quiet line in mono, and the remove control (`pb-chip-remove`, "Remove <name>" to a screen reader). A long name is shortened in the middle, so its end stays in sight: two screenshots differ by their time. The whole name is in the title and read out.
- States (`data-status`): **uploading** says "Uploading" and draws a 2px `accent-text` line along its foot that only grows, then fades (`pb-chip-progress`); **done** shows the size ("240 KB"); **failed** offers "Try again" (`pb-chip-retry`, in `accent-text`) in the place of the size; **refused** says "Too big" or "Can't attach" in `clay`. A failed or refused chip dims its thumbnail. The chip's height and width never change between states.
- The line says one thing: a problem first, in `clay`, in full words ("Screenshot 2026-11-13 08.12.png is too big. A file can be up to 100 MB.", "report.pdf didn't upload. Try again.", "You can attach up to 10 files to one message."); else "Uploading 2 files" in `ink-faint`, or, while a send waits for it, "Uploading 2 files. Sends when they are done." ("Uploading 1 file. Sends when it is done."); else nothing, with its room kept.
- Several problems at once: the line gives the reason of the chip with the focus or the pointer on it, else of the first one, and ends with how many more ("Huge scan.png is too big. A file can be up to 100 MB, and 1 more can't be attached."). Each failed or refused chip carries its own whole reason as its name to a screen reader and as its tooltip.
- More chips than the row shows: the row's edge fades softly on the side where more are (`data-more-start`, `data-more-end`, a mask over `space-7`, so nothing moves), and the line says how many when it has nothing more urgent: "10 attached". An upload or a problem keeps the line, with the count before it when both fit ("10 attached. Uploading 2 files."); when they do not, the message alone.
- A file starts uploading the moment it is added, so Send has nothing to wait for. Pressing Send while one still uploads makes the send button wait (`data-waiting`: a little quieter, the same size and place) and the message goes by itself when the upload is done. Send with a failed or refused chip keeps the message and every chip, and the line says what to do.
- A message may be pictures and files alone, with no text.

**Three ways in.**

- Paste: a screenshot pasted into the message box (on Windows Win+Shift+S, then Ctrl+V) becomes a chip named "Screenshot 2026-11-13 08.12.png". Pasting text works exactly as before.
- Drop: files dragged over a bot's chat draw a calm 2px `focus` outline inside the panel and one line in the middle, "Drop here to attach" (`pb-drop`, `pb-drop-note`). It lies over the chat and changes no layout. Drags of text are left alone.
- Pick: the add button at the left of the composer's bar, "Attach pictures or files", opens the system's picker of files.

**In the chat.** A message from the person shows its pictures and files above its bubble, on the right.

- A picture (`pb-picture`) stands in a box of its final size before it loads, from the width and height the engine stored: the longest side at most 320px, never less than 48px a side, and never wider than the message column (it then shrinks in its own proportions). The box is `fill` with `radius-lg` until the picture is there; the picture fades in inside it over `dur-quick`. No line above or below moves by a pixel when it arrives, also for a picture in an older page of history loaded while scrolling up. Its alternative text is its name.
- A file (`pb-msg-file`) is the chip without the remove control: the sheet, the name, the size. It downloads on a press. A file that is no longer on the Mac says so quietly, "This file is no longer on the Mac.", and is not a link.
- A message with pictures and no text has no empty bubble.

**The large view** (`pb-picture-view`). A press on a picture opens it large, as a dialog on the dimmed layer: an overlay card with the name and Close on top and the picture as large as the window allows, never larger than the picture itself. The preview the chat already has stands in at the final size until the full picture has loaded over it. Escape, Close and a click outside the picture close it, and the focus goes back to the picture. The chat underneath does not move.

Keyboard: everything is reached with Tab. In the composer the order is the chips (each one's Try again and remove), the text, Attach, the model, Send. Every control shows the 2px `focus` ring.

**Since 14 Nov 2026 (step 7c): any file, kept 14 days.** Any kind of file can be attached, up to 100 MB: a zip, a recording, anything. Only "Too big" and the count still refuse a chip ("Can't attach" for a kind is gone). In the chat a file the bot cannot read is a file chip like any other. After 14 days Pobots removes an attachment from the bot's folder: its chip in the chat keeps its place and size and says "No longer kept" where the size was, and it no longer downloads (a picture becomes such a chip; no broken picture).
