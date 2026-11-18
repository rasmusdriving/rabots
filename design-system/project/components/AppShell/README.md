The app window: the roster on the left, one bot's chat in a floating panel in the middle, and what needs you on the right.

This is a reference screen, built only from the other components. Use it to judge the whole, and as the starting layout for the real app.

- **Left, on `ground`**: the name, "Today", the bots with a quiet add control beside their title (`pb-side-head`), and at the bottom the channels (with their own add control, see ChannelList) and the machines. A channel opens its page in the reading panel in place of a bot's page. Bots are the navigation. There is no list of chats. The add control opens the "Add a bot" sheet (see Dialog).
- **Middle, the panel on `surface`**: the open bot's page. A header with its avatar, role, quiet text tabs (Chat, Job, Files, Artifacts, Triggers, History, Settings; see Tabs) and status, then the open tab: the thread and the composer for Chat. The panel has `radius-xl` and `shadow-panel` and stands a `space-2` gap in from the top and bottom of the window.
- **Right, on `ground`**: the "Needs you" rail. Raised cards: approvals first, then choices, then a quiet list of what is planned later today (`pb-later`): the scheduled runs still to come today, one line per trigger at its next time, as "Name by Bot". It is only there when there is something. A line opens that bot's Triggers tab at that trigger. At the rail's foot, in sight however many cards wait: the bots' task managers (see TaskManagers), the helpers at work (see HelpersAtWork) and the person's to-do list (see TodoList).

Rules for the whole window:

- No lines between the three areas. The panel's lightness and shadow are the separation.
- At rest, the only things that may move are the faces and status marks of bots that are working, thinking or waiting.
- The rail shows at most what fits without scrolling on a normal laptop screen. Older cards wait under "Today".
- "Today" opens the same cards full width, with the day's meetings and planned runs.
- A bot's job, files, history and settings are its tabs, all editable in place. Leaving unsaved text anywhere asks first.
- Under "Machines", the engine's machine reads "this one" in the desktop app and in a browser on that machine, and "connected" in a browser on any other device.

**The rail's width** (17 Nov 2026). The person can make the rail wider: a handle on its left edge, in the rail's own padding (`pb-rail-handle`, `space-3` wide), with a small pill for a grip drawn quietly in `fill` that turns `fill-strong` on hover, focus and while dragging, and a resize cursor. Dragged left the rail gets wider, right narrower: never narrower than 280 px, never wider than 720 px, and never so wide that the chat has less than 480 px. A double-click on the handle puts the rail back to its default, which follows the window (344 px, 296 px below 1180 px, 280 px below 900 px). With the keyboard it is a separator like the artifact panel's line: Left arrow wider, Right arrow narrower (16 px a step), Home widest, End narrowest. The width is remembered in this browser only and shown from the first frame after a reload. The chat keeps its place while the rail changes width. There is no handle on the phone, in a window too narrow for a choice, or while the artifact panel or the browser stands in the rail's place.

**Nothing past the rail's edge.** Every card and row fits the rail at any width: long words and addresses in a card's title, text, well and button labels wrap; one-line rows (later today, helpers, to-dos) end in an ellipsis. The rail never scrolls sideways.

**The artifact panel** (step 2f, see Artifact). Opening an artifact puts a second reading panel in the place of the rail, beside the chat, with a line between them that can be dragged. It takes about half of the space beside the roster, never less than a readable width for either side, and the width is remembered. While it is open the rail is out of sight (still laid out, so nothing in it arrives again) and the panel's top line says "Needs you 2" when cards wait. One control makes it fill the main area, the chat hidden behind it. In a window too narrow for both (at 800 px) it takes the place of the chat, with a way back. The chat keeps its place through all of this; only its width changes: the artifact's row stays where it is when the panel opens or closes, if it is in view, and otherwise the line at the top of the view does. It closes when another bot is chosen, and stays open across the bot's tabs.

**The browser in the same panel** (step 2g, see Browser). The bots' browser opens in the artifact panel itself: one panel, two kinds of content. Width, divider, fill, the way back at 800 px, "Needs you 2", Escape, the focus back to the row and the chat keeping its place are the same. Opening the browser while an artifact is open swaps the content and the other way round; the panel and its divider stay. Unlike an artifact, the browser is not one bot's: it stays open when another bot or a channel is chosen. At the bottom of the roster, with the machines, a quiet "Browser" line says how much is open ("2 open") and opens it; it is there only while the browser can be reached, and in a roster of faces only it is a small drawn window.

**Pobots settings** (job 5, see PobotsSettings). At the very foot of the roster, under the machines, one quiet line, "Pobots settings", opens the settings page for Pobots as a whole in the reading panel. The bot's or channel's page stays laid out underneath, out of sight, and what is open beside it steps aside, so going back shows both exactly as they were. Opening it moves nothing in the roster. While no backup key is saved the line carries a small quiet dot (`ink-muted`, 6px), read out as "backup not set up": not an alarm, no colour, no count. In a roster of faces only it is the small drawn sliders, with the dot on the mark's corner.

## First start (engine 0.33.0)

With no bots yet, the window shows one calm screen instead of the shell (`app-first`), centred on `ground`, at most 440px wide:

- the face at its largest, the title "Welcome to Pobots" (`display`), and one muted line: "Start with your main bot. It looks after your other bots, makes new ones with you, and first gets to know you a little."
- the field "Name your main bot", filled with "Po" (selected and in focus, so typing replaces it), the hint "You can change it later." (an error takes its place),
- "Model": the model choices as "Add a bot" has them (see ModelPicker, two groups with both providers), the default Opus 5.5,
- one primary button, "Create main bot".

The main bot made here starts by itself: its greeting is the first thing in its chat, with a question or two about the person. There is no second step and no wizard. On a phone the field and button are 44px and the model choices 40px with a 44px place to tap, with the page's own side room. An install with bots never sees this screen.
