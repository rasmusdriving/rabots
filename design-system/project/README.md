Pobots is a desktop home for bots that help one person with their work. The interface should feel like a quiet room at night: almost no colour, nothing outlined, a few soft surfaces resting on a dark ground. The bots do the moving; the screen stays still.

## Principles

- **Quiet by default.** Nothing moves, glows or counts unless a bot is working or something needs you. An idle app looks finished, not empty.
- **Surfaces, not lines.** Things are told apart by how light they are and by their shadow. There are no borders around panels, cards, inputs or buttons.
- **Almost no colour.** The interface is black, grey and white. `accent` marks the one thing to press. `amber` and `clay` appear only when a bot waits for you or is blocked.
- **One thing at a time.** What needs you is a short list of cards, one decision per card. Everything else waits out of sight.
- **Bots report, they do not nag.** No red badges, no unread counters, no sounds by default.
- **Less on screen.** If a control is not needed right now, it is behind a click. A composer is a text box, a model name and a send button.

## Voice

- Write in sentence case. No capitals for emphasis, no exclamation marks, no emoji.
- Bots say "I". They address the person as "you". The app itself has no voice of its own beyond labels.
- Lead with the result, then the next step: "Done. The prep is at 08:30 tomorrow."
- Buttons say what happens: "Allow once", "Always allow", "Deny", "Later". Never "OK" or "Submit".
- Count gently: "Two things need you", not "2 alerts".
- Be kind with time. Say when, not how late: "Friday 13:00", "in 20 min", "expires in 28 min".
- An error says what happened and what to do: "I could not reach HubSpot. I will try again at 09:15."
- Use a middle dot to join short facts: "Main bot · Opus 5.5". Do not use long dashes in app copy.

## Surfaces

Five levels, from back to front. Each level is a little lighter than the one behind it and carries its own shadow. That step is the only edge it gets.

| Level | Colour | Shadow | Used for |
| --- | --- | --- | --- |
| Window | `ground` | none | The roster and the rail sit directly on it. |
| Panel | `surface` | `shadow-panel` | The reading panel: a bot's chat, a settings screen. |
| Raised | `surface-raised` | `shadow-raise` | Cards, the composer, the selected roster row. |
| Overlay | `surface-overlay` | `shadow-float` | Menus, pickers, dialogs. |
| Well | `surface-sunken` | `shadow-well` | Inputs, drafts, segmented controls. Pressed in, not raised. |

- Never draw a border to separate two things. Change the surface level or add space.
- `fill` and `fill-strong` are soft tints that work on any level: secondary buttons, chips, key hints, hover, your own message bubble, bot avatars.
- `divider` is a last resort inside one surface, for example between two groups in a long menu. It never goes around anything. In a chat it is the rule on both sides of the fresh start line, drawn as a 1px fill, never a border.
- In the light theme the levels are white on a grey `ground` and the shadows carry the difference. In the dark theme the lightness steps carry it and the shadows add a faint highlight along the top edge.
- Dark is the first theme. Light is equal: design every screen in both.

## Colour

- Text is `ink`. Secondary text is `ink-muted`. Timestamps, placeholders and section titles are `ink-faint`. On a `fill`, use `ink-muted` instead of `ink-faint`.
- `accent` is the only colour in the resting interface. Use it as a fill for the primary action on a view and for the send button, with `on-accent` text. One `accent` button per view.
- Use `accent-text` when the accent is text or a small mark on a dark or light surface: links, the working mark.
- `amber` means waiting for you. `clay` means blocked or destructive. Never use either to decorate.
- A bot's face is a `pebble` body with `ink` eyes. Since 14 Nov 2026 each bot's pebble has a colour of its own from a palette of eight muted colours (`pebble`, `pebble-sky`, `pebble-teal`, `pebble-moss`, `pebble-sand`, `pebble-copper`, `pebble-rose`, `pebble-lilac`), so bots are told apart by their colour as well as their eyes and name. These colours are the face's only; they never mark state and never colour anything else.

## Faces

Every bot has a face: a soft square with a pair of eyes. The face is how a bot feels alive without adding noise.

- Each bot has its own look for life, made from an eye shape (round, tall, wide, square) and an eye spacing (near, normal, far).
- Faces are eyes only. No mouth, no brows. The pebble has the bot's colour; the eyes are always `ink`, at least 9:1 on every colour in both themes.
- The eyes show the bot's state: asleep when idle, drifting when thinking, down on the work when working, looking at you when waiting, tilted with worry when blocked, happy arcs when done.
- Movement is tiny and slow: a drift of a few hundredths of the face, a blink that is over in a fifth of a second. A face never bounces, spins or follows the pointer.
- An idle bot is asleep and perfectly still. It peeks with one eye when you hover its row.

## Status

A bot is always in one of six states. Each state has a word, a mark and a face, so colour is never the only signal.

| State | Mark | Colour | Face | Motion |
| --- | --- | --- | --- | --- |
| Idle | hollow ring | `ink-faint` | asleep | none |
| Thinking | three small dots | `accent-text` | eyes up, drifting | dots rise in turn, eyes drift |
| Working | dot with a halo | `accent-text` | eyes down | halo breathes, a blink now and then |
| Waiting | dot inside a soft ring | `amber` on `amber-soft` | looking at you | a slow blink |
| Blocked | small square | `clay` | worried | none |
| Done | check on a soft disc | `accent-text` on `accent-soft` | happy | settles in once |

Waiting asks for attention by being still and warm. Its mark never moves; the face only blinks.

## Type

- Everything is set in Instrument Sans (`font-sans`). Times, key hints, file names and tool names are set in Geist Mono (`font-mono`).
- Use `body` for messages and running text, `small` for supporting lines, `label` for status words and chips.
- Use `heading` for section headings, `title` for a screen title, and `display` at most once per screen.
- Keep running text to about 68 characters per line.
- Weight carries emphasis: 400 for text, 500 for labels and buttons, 600 for names and headings. Do not use italics or underlines for emphasis.

## Space and shape

- Spacing follows a 4px grid: `space-1` to `space-8`. Give content room. When in doubt, use the larger step.
- Corners are generous. The reading panel and the composer use `radius-xl`. Cards, menus and bubbles use `radius-lg`. Buttons, inputs and rows use `radius-md`. Chips and menu options use `radius-sm`.
- The soft square, `radius-pebble`, belongs to bots alone.
- Do not put a coloured stripe on the edge of a card. State is shown by the mark and its word.

## Motion

Motion should be felt more than seen. It is snappy at the start and calm at the end.

- **Feedback is instant.** A press settles in `dur-instant`. Hover, focus and switches take `dur-quick` with `ease-soft`.
- **Things arrive, they do not pop.** A new message, card or menu fades in and rises 6px over `dur-calm` with `ease-out`.
- **Exits are faster than arrivals.** Anything leaving takes `dur-quick` and does not travel.
- **Only bots move.** A bot's face and its status mark are the only things that loop: the working mark breathes once every `dur-breath` with `ease-breath`, the thinking dots rise 2px in turn, eyes drift or blink. Nothing else in the app repeats. No spinners, no shimmer, no progress bars that race.
- **Nothing flashes, shakes or slides in from the edge to demand attention.**
- **Lists stay put.** New items are added in place. The roster never reorders itself while you look at it.
- **A line that changes keeps its box.** When a line in a chat turns from one state into another (a bot writing down what matters becoming "Started fresh", a helper's row going from "Working" to "Finished"), both states have one fixed height and the new words fade in where the old ones were. Nothing above or below it moves, and nothing scrolls or takes the focus.
- **A turn reads in the order it happens.** In a bot's chat a new thing only ever comes at the very end: text, a line of work, more text. The live thing is the last thing itself (a running step, the arriving text); a quiet thinking line stands at the end only while nothing is live, with the height and left edge of a line of work, and what comes next takes its place without anything moving. When the turn has ended, its work folds into one line, "Worked for 1m 11s", that opens it again in place. The fold fades the work out without travel and keeps the place the person reads.
- **What is shown again does not arrive again.** Going back from a helper's thread to the chat shows every line where it was, at the same place in the chat, with no fade or rise; a thread read for the first time comes in as a whole. Only lines that are new arrive.
- **A change of width keeps the place.** When the chat gets narrower or wider (an artifact opens beside it, closes, fills the main area, or the line between them is moved), what the person is looking at stays at the same height. When an artifact opens or closes, that is the artifact's row, if it is in view (a long message above it may wrap anew, and the row they just opened must not move away); otherwise, and when the line between them is moved, it is the line at the top of the visible chat. Width is never animated: the text reflows once, and the panel fades in without travel.
- **A page that changes is swapped, never emptied.** An artifact that loads again loads out of sight under the one shown and takes its place once it has loaded. A loading line waits a moment before it shows, so a fast load never flashes it.
- **A picture keeps its box.** A picture in a chat stands in a box of its final size before it has loaded, from the size the engine stored, so no line above or below it moves when it arrives, also in an older page of the chat read while scrolling up. The tray of what is attached in the message box keeps its height while files upload, fail or finish; only the first one grows the box, once, as a second line of text does. A picture opened large is a dialog over the chat; the chat underneath does not move.
- **A live picture is replaced, never emptied.** The browser's picture is drawn once each new one is decoded, over the one before; the panel never shows an empty moment, also not when the connection comes back or another page is picked. A line in the chat whose workspace closes turns "Closed" in its box and stays where it is.
- With reduced motion turned on, loops stop and arrivals become a plain fade of `dur-quick`.

## Layout

- The window is `ground`. The roster (264px) and the "Needs you" rail (344px) sit directly on it. Between them one reading panel floats on `surface` with `radius-xl`, a `space-2` gap from the window edge.
- The sidebar lists bots, not chats. A row shows the bot's face, the name, one line about what the bot is doing, and its status mark on the right. Under the bots, a quiet "Channels" group lists the outside places where people write to bots, each with "on" or "off"; a channel opens its page in the reading panel in place of a bot's.
- The rail holds only what needs a decision, as raised cards. When it is empty it says so in one line.
- The composer is a raised, rounded box at the bottom of the panel: a text line, an add button, the model as quiet text, and a round send button. Nothing else, except the tray of pictures and files above the text while something is attached.
- While a bot works, a message the person sends goes into what it does ("Steered") or waits until it is done ("Queued"), by the choice under "When a bot is working" in Pobots settings. The send button says which; Ctrl+Enter, or holding the send button on a phone, does the other for one message (see Composer).
- Choosing a model opens a picker that floats above the composer: models on the left with key hints, effort on the right.
- Everything about a bot is edited inside the app. Never send the person to a file browser or an outside editor.
- An artifact a bot made opens in a panel in the place of the rail, beside the chat (see Artifact). While it is open the rail is out of sight and the panel's top line says "Needs you 2" when cards wait. The page runs in a sealed frame on `frame-ground`; the app never reads from it or writes into it.
- The bots' browser opens in the same panel (see Browser): one panel, two kinds of content. The person watches the live picture and steps in with "Take control". The words are "the browser" and "page", never "tab", "session" or "stream". The pages of what is shown stand in a row of pages above the picture, at one fixed height, always there; the picture is drawn as sharp as the real page once it stands still.
- At the very foot of the roster a quiet "Pobots settings" line opens the settings page for Pobots as a whole in the reading panel, over the open page, which stays where it was underneath. A setting that needs the person (no backup key yet) is a small quiet dot on that line, never a badge or a colour.
- How full a bot's working session is shows in its Settings only, as words ("About 38% full · Since 11 Nov 14:52"). No meter, bar or badge in the roster or the header: it is not something to watch.

## Phone

A window narrower than 700px, or a touch screen less than 500px tall (a phone on its side), is a phone. Nothing about the laptop changes: every phone rule lives inside that one query.

### Layout and getting around

- One column, one thing on screen at a time. Three screens: **Bots** (the first one), **a bot** (its chat, or a channel's page) and **Needs you**. Over them, full-screen sheets: the bot's page, an artifact, the browser and Pobots settings.
- Bots is the roster at the full width on `ground`: the name, the bots as rows of 56px with the face, the name, the one line and the mark, then channels, the browser and, at the foot, "Pobots settings". While cards wait, one raised row under the name says so gently ("Two things need you") and opens Needs you. Nothing reorders.
- A bot's screen is the reading panel at the full width on `surface`, with no gap and no corners. Its head: the way back ("Bots"), the face, the name and what the bot is doing, "Needs you" with the count while cards wait anywhere (the mark and the count when the head is narrow; the words are read out), and "Page". There are no tabs on the chat.
- "Page" opens the bot's page as a sheet: the way back reads "Chat", and the tabs stand in a row that scrolls inside itself, never the page.
- A file opened in the page's Files is a step of its own: the way back then reads "Files" and leads to the list of files, and from there "Chat". The browser's back does the same. With unsaved text every way back asks first. Choosing another tab closes the file's step first, so back from that tab is the chat.
- The chat comes back from the bot's page exactly where it was: the same line at the top, no line fading in or rising, a picture it showed before simply there. Opened from a notification it shows its newest message.
- Needs you is the rail's cards in one column, the "Later today" list under them. Answering a card takes two taps from Bots. A typed answer puts the field on its own line and the buttons under it. With every card answered it says "Nothing needs you" and stays.
- An artifact and the browser fill the screen. Their top line takes two lines: the way back, "Needs you" and the small controls first, the title under them at the full width, so it is never cut. The browser is watch only on a phone; one quiet line says "Take control from a computer."
- Every screen and sheet is a step in the browser's history: the way back, the browser's back, Android's back gesture and the iOS edge swipe all do the same. The way back is a chevron and the name of where it leads, at the start of the head. A reload keeps the screen. Going back to Bots finds the row that was tapped where it was, with the focus on it.
- A screen changes as a whole, in one frame: no slide, no fade between screens, nothing that was read moves. What is not on screen stays laid out underneath, out of sight, so it comes back exactly as it was.
- The window is as tall as what is visible above the on-screen keyboard: the head stays at the top and the message box above the keyboard.
- Safe areas: heads start below the notch, feet end above the home bar, and on a phone on its side the sides keep clear of the notch.
- Touch: every control is at least 44px to tap; a small one is drawn as it is with a 44px place to tap around it. Rows are 56px. A tap leaves no hover fill behind.
- The home screen icon is the face on the dark `ground`, full bleed, with no see-through corners: 180px for iOS, and a maskable 512px with the face well inside the middle for Android.

### The chat and typing

- The chat reads at the full width less `space-4` on each side. Lines that open ("Worked for 1m", a folded turn) keep their height; the place to tap them is 44px, centred on the line.
- The composer is the same raised box at the full width. Its text is 16px, which keeps iOS from zooming the page; zoom itself is never blocked. Enter adds a line and the send button sends: a phone keyboard has no Shift, and a stray send is worse than a stray line. The box grows a line at a time to five lines, then scrolls; a chat at its bottom stays at its bottom.
- When the keyboard opens or closes, a chat at its bottom stays there and a chat read further up keeps its top line where it was. The keyboard never opens by itself: not after a photo is attached, not when a chip is removed, not when a dialog or the model picker opens.
- The add button opens the phone's own choice of photos, the camera and files. A photo larger than 2048px on its long side or over 4MB is redrawn to 2048px before it uploads, so it goes quickly over mobile data; its chip says "Preparing" in its own fixed box, then "Uploading". A photo the phone cannot redraw goes as it is.
- The tray of chips fits the box: the chips scroll inside their own row, never the page. A chip's remove is drawn at 28px with a 44px place to tap.
- A picture opened large fills the screen on `ground`, its name and Close at the top. Two fingers zoom the picture itself and a double tap zooms to twice the size around the tap and back; the page itself never zooms from the picture. Back closes it, and the chat underneath has not moved.
- The model picker is a sheet from the bottom at the full width: search, the models one per line at 44px, the efforts as a row of choices, then Fast and the foot. No key hints. Back closes it.
- A dialog is a centred sheet almost the width of the screen, never taller than what is visible, its foot reached by scrolling inside. With the keyboard open it stands at the top of what is visible. Back closes it.
- Inside the bot's page and Pobots settings: fields at the full width, 44px tall, text at 16px; buttons 44px, small ones drawn at 40px with a 44px place to tap; a switch is drawn as it is with a 44px place to tap around it. Nothing is wider than the screen.

## Focus and legibility

- Controls have no outline at rest. Keyboard focus shows a 2px `focus` ring on every interactive element. Never remove it.
- A text box that fills a surface (the composer, the editor) rings the whole surface instead of the text, and only when the person uses the keyboard.
- All text meets 4.5:1 on the surfaces named in its token note, in both themes.
- Inputs and secondary buttons are marked by their fill and shape, which is a softer edge than a border gives. This is a deliberate choice for calm; the focus ring and the label carry the rest.

## Iconography

- Use Lucide icons at 16px or 20px with a 1.5px stroke, in the text colour beside them.
- An icon always sits next to a word, except add, send and close, and the small controls in an artifact panel's top line, which show their words on hover and to screen readers because the artifact needs the room.
- Status marks are drawn with CSS shapes, not icons, so they stay crisp at 10px. The two checks, the idle ring and the working halo are masks of small drawn shapes, because anything made of fractional borders smears at Windows screen scaling.
- A message from a trigger carries a small drawn mark where a face would be: a clock for a schedule, an arrow coming in for a webhook. Never a bolt or an alarm.
- A message from a channel, and a channel in a roster that shows faces only, carries a small drawn speech mark. A channel's page carries the same mark at the size of a face in its head.
- A helper (a worker a bot starts for one task, on its own model or another) carries a small drawn arrow turning in under a line, on a soft disc, wherever a face would be: on its row in the chat, beside its messages in its own thread. Never a face: a helper is not a bot. The word is always "helper", never subagent, agent, task or worker.
- An artifact carries a small drawn page with a folded corner on a soft disc; one that lives on Claude, a page with an arrow leaving it. The word is always "artifact".
- The browser carries a small drawn window with a line across its top, on a soft disc, on its row in the chat and on the roster's Browser line. Never a globe from an icon set, never a face. The browser panel's small controls show their words on hover and to screen readers, like the artifact panel's; "Take control" and "Hand back" are words, because control is a state the person must see.
- There is no logo yet. Set the name "Pobots" in `font-sans` at weight 600.
- A card from Pobots itself (not from a bot) carries Pobots' own mark where a face would be: the first letter of the name, set like the wordmark, in a soft round disc. Never a face and never the pebble: Pobots is not a bot.
- Pobots' settings page carries the small drawn sliders on a soft disc, in its head and on the roster's "Pobots settings" line. Never a cog that turns.
- A notification shows the app's icon. Android's status bar draws a badge where only the shape counts: the pebble filled, with the two eyes cut out (`badge-96.png`, made by `scripts/make-icons.mjs`).
