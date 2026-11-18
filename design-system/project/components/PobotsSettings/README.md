The settings page for Pobots as a whole (job 5): what belongs to the app, not to one bot. Reached from the quiet "Pobots settings" line at the foot of the roster (see AppShell) and from a card from Pobots ("Open backup settings").

## The page

- It stands in the reading panel's place. The bot's or channel's page stays laid out underneath, out of sight, and what was open beside it (an artifact, the browser) steps aside while the page is open; going back shows both exactly as they were, the chat at the same place.
- **The head** is a bot page's head: the small drawn sliders on a soft disc at the size of a face, "Pobots settings", one muted line "For the whole app, not one bot", and a quiet "Back to Kaja" with a back arrow at the right. Opening gives the title the focus (no ring: it is not a control); going back gives the focus to what opened it, else to the roster's line. Escape goes back, except in a field. Choosing a bot or a channel in the roster leaves the page for it. A reload keeps the page open (the history entry is marked, as for a helper's thread); back still returns to the chat that was open.
- **Sections** like a bot's Settings tab (`pb-settings`, `pb-section`): one calm column, a heading per section. "About you" is the first (engine 0.33.0), then "Notifications", then "When a bot is working", then "Backup", whose list of runs stays the last thing on the page.

## About you (engine 0.33.0)

The first part of General. A short note about the person that every bot gets in its instructions; the main bot writes it when they first meet (see AppShell, "First start") and can change it with `change_settings`.

1. **What it is** (`pb-section-text`): "A short note every bot gets: who you are, what you do, what matters to you and how you like to be talked to. Your main bot writes it when you first meet. Change it here, or ask your main bot."
2. **The text box** (`pb-about-input`, a `pb-textarea` at least 144px tall, named by the section's title), empty with the hint "Who you are, what you do, what matters to you."
3. **One line under it** (`pb-about-foot`): at the left the count, "81 of 4,000 characters", which becomes what is wrong ("Keep it under 4,000 characters.", or the engine's sentence) in the same place, so nothing moves; at the right a small **Save**, lit only when the box holds an edit. "Saved" shows beside the title for a moment.
4. A change from the main bot shows in the box at once, unless the box holds an edit not saved yet: that edit stays until it is saved.

On a phone Save is 40px with a 44px place to tap.

## When a bot is working

Steering (13 Nov 2026), after T3 Code's "Follow-up behavior". The words are "steer", "queue", "message", "the send button". Never "follow-up", "interrupt" or "inject".

1. **What it is**, one sentence: "What happens to a message you send while a bot is in the middle of something."
2. **The choice** (`pb-followup`), a choice list like a bot's access level (see ChoiceList): **Steer**, "Your message goes into what it is doing now. It reads it at its next step." (the default), and **Queue**, "Your message waits until it is done." It saves at once; "Saved" shows beside the title for a moment. The arrow keys move the choice.
3. **The other way for one message** (`pb-followup-other`, a muted hint): "For one message, do the other: press Ctrl+Enter on a computer, or hold the send button on a phone." (⌘+Enter on a Mac.)
4. **A line that keeps its room** (`pb-followup-problem`) for a choice that could not be saved, with the client's sentence, so nothing below moves.

On a phone each choice is at least 44px to tap and the section is the full width, like the rest of the page.

## Notifications

Notifications when the Pobots page is closed (job 4). The words are "notifications", "this device", "the push service" (only in a test's result and a device's line, where it names who refused), "home screen". Never "push subscription", "service worker", "VAPID" or "endpoint". A notification itself says only which bot and what kind of thing; its words are made by the engine, not here.

From top to bottom:

1. **What it is**, two sentences: "Pobots can let this device know when a bot needs you, also when the page is closed. A notification only says which bot and what kind of thing, never what the chat says."
2. **This device** (`pb-notify-device-part`): the status in one line with its mark (`pb-notify-line`, body size, a status for screen readers), then one row of actions (`pb-notify-act`, in line with the words), then one muted line (`pb-notify-note`) that keeps the room of the longest it says.

   | State | Status line | Mark | Actions |
   | --- | --- | --- | --- |
   | The desktop window | Notifications work in Pobots in a browser, not in this window. | ring | none |
   | Not a secure address | This address is not secure, so the browser does not allow notifications. | ring | none |
   | The browser cannot | This browser cannot show notifications from Pobots. | ring | none |
   | iPhone or iPad in a browser | On an iPhone, notifications only work when Pobots is opened from the home screen. | ring | the three steps under it (`pb-notify-ios`) |
   | iPhone too old | This iPhone needs iOS 16.4 or later for notifications. | ring | none |
   | Off | Off on this device. | ring | **Turn on for this device**; the line under it "Your browser asks once. Choose Allow." while the browser has not asked |
   | The browser asks | Waiting for your answer in the browser. | waiting | the same button, not pressable |
   | Blocked | Notifications are blocked for Pobots in this browser. | blocked | quiet **How to allow them**, which opens the steps for this browser below everything else in the part (`pb-notify-allow`) |
   | On | On for this device. | check | **Send a test** ("Sending" at the same size while it goes) and a quiet **Turn off for this device** |

   The line under the actions: "Sent at 14:02. It should arrive in a few seconds.", or in `clay` "The push service refused it: BadJwtToken.", "The push service could not be reached.", "Allowed, but Pobots could not keep this device." with the engine's sentence, "Allowed, but the browser could not set up notifications here. Try again in a moment."

   The steps on an iPhone in a browser: "Tap the share button in Safari (the square with an arrow pointing up). If you do not see it, tap the three dots first.", "Scroll down and tap Add to Home Screen, then Add.", "Close Safari, open Pobots from the home screen, and turn notifications on in Pobots settings."

   How to allow them, only for the browser in use: Edge or Chrome on a computer "Click the icon left of the address (a lock, or two sliders), open the site's permissions, set Notifications to Allow, then reload the page." (on Windows also "If they are allowed but none arrive, open Windows Settings, then System, then Notifications, and check that your browser may show them."); a home screen app on an iPhone "Open the iPhone's Settings, then Notifications, choose Pobots and turn on Allow Notifications."; Android "Tap the icon left of the address, then Permissions, and turn Notifications on."; Safari on a Mac "In Safari, open Settings, then Websites, then Notifications, and set this site to Allow."
3. **What to tell you**, with "For all your devices." under the title and "Saved" beside it for a moment: three rows (`pb-notify-kind`), the words at the left, the switch (`pb-switch`) at the right. "Needs your answer" (A bot asks you something or asks to do something.), "Sent you a note" (A bot, or Pobots itself, puts a note in front of you.), "Finished" (A bot finished something you asked it to do, or stopped because of a problem.). A switch changes at once and saves itself; one that cannot be saved goes back and says why in a line under the rows that keeps its room.
4. **Your devices** (`pb-notify-devices`), oldest first, so a new device comes at the bottom: the name ("Edge on Windows", "Home screen app on iPhone"), "This device" in a soft pill beside the browser in use, one muted line ("Added 13 Nov. Nothing sent yet.", "Added 13 Nov. Last sent today at 14:02.", in `clay` "Last try today at 14:02 was refused: BadJwtToken." and "Stopped working on 14 Nov. Open Pobots on that device and turn notifications on again."), and a quiet **Forget** at the right, read out as "Forget Edge on Windows". No dialog: turning on again on that device undoes it. "No devices yet." when there are none.

Calm: the page never asks the browser for permission by itself, only from the press on "Turn on for this device"; nothing about notifications shows anywhere else (no prompt, no banner). Every line of "This device" keeps its box through off, the browser's question, on, a test and its result; the button keeps the focus when "Turn on" becomes "Send a test". What opens (the steps) opens below what he reads. On a phone the buttons are drawn at 40px with a 44px place to tap, the switches and the rows of "What to tell you" are 44px to tap, and a device's line runs under its name and Forget at the full width.

The notification itself: the app's icon, and for Android's status bar a badge where only the shape counts (the pebble with the two eyes cut out). A click brings an open Pobots window to the front and opens the bot (on a phone, "needs" shows Needs you), or opens Pobots there when none is open.

## Backup

The words are "key", "public key", "private key", "fingerprint" (the words 1Password shows), "RSA", "4096" and "OneDrive". "SSH Key" only as the name of the item he picks in 1Password, "SHA256" only inside the fingerprint, "ssh-rsa" only where a line says what the pasted key starts with, "Ed25519" only in the refusal that says he picked the wrong kind. Never the names of the methods that lock the file.

From top to bottom:

1. **What it is**, in three plain sentences: every night at 03:00 all chats, every bot's folder and the settings go into one locked file in OneDrive; only the key in 1Password can open it; the last 14 nights are kept.
2. **The state** (`pb-backup-line`) in one line with its mark, at body size: "No backups yet. Add a key to start.", "Backing up now.", "Last night at 03:00, 3.2 MB, saved to OneDrive." (quiet check), "Made today at 14:12, but OneDrive has not confirmed it yet." (hollow ring), "The backup today at 14:12 failed. The reason is under Recent backups." (the blocked square, `clay`). It is a status for screen readers.
3. **The next run** (`pb-backup-next`), muted: "Next backup tonight at 03:00.", or "Backups start once a key is saved."
4. **"Back up now"** (`pb-backup-now`), a secondary button. While a backup runs it reads "Backing up", at the same size, off for now; the state line says "Backing up now." at the same moment. Off with no key, with the next line as its reason.
5. **Your key**: two or three sentences on what to do when there is none (in the private vault in 1Password make an SSH Key of the kind RSA, 4096 bits, copy its public key, paste it here; the private key stays in 1Password), or, with a key, to compare the fingerprint with 1Password ("If they are the same, new backups are locked to this key."). Then the fingerprint (`pb-backup-print`) in `font-mono` in a well, with "RSA 4096 · Saved today at 09:12" under it, and under that one quiet line (`pb-backup-print-old`) when the list holds backups made before the key was changed: "Backups made before you changed the key still need the old key." Its room is kept in every state. The fingerprint and its facts change in place without a fade (`pb-swap-still`): the old one stays fully readable until the new one stands in its box. Then the field to paste a public key (`pb-backup-input`, mono, three lines, Enter saves) with "Save key" beside it, and one line under it (`pb-backup-note`) that keeps two lines of room: what to paste, or the engine's plain refusal in `clay` in its place ("This RSA key has 2048 bits. Make one of 4096 bits."). A pasted private key is refused by the window itself with the engine's sentence; the field empties and nothing is sent. Saving says "Saved" beside "Your key" for a moment and empties the field. Last in the key part, in both states, a quiet "How to make a key" (`pb-backup-how-toggle`, `aria-expanded`) opens the short steps in place below it (`pb-backup-how-steps`): New Item, SSH Key, Generate a New Key of the kind RSA and the size 4096 in the private vault, copy the public key here; the key belongs in the private vault, not a shared one, and the private key never leaves 1Password. Opening is his own act, and nothing above the steps moves.
6. **Where the files go**: the folder as a person says it, muted ("OneDrive, folder Pobot" for a folder in the Mac's OneDrive, with the folders after it; any other folder by its last two names), the full path as its tooltip and accessible description. Under it a line (`pb-backup-folder-problem`) that keeps its room in every state: empty, or the engine's sentence when the folder cannot be used ("Pobots cannot write to the backup folder. Check that OneDrive is running on the Mac and that the folder is still there.").
7. **Recent backups** (`pb-runs`), quiet lines, the last thing on the page, **oldest first and the newest at the bottom, like the chat**: the mark, "Saved to OneDrive", "Not confirmed by OneDrive" or "Failed" (`clay`), a muted line ("3.2 MB · Nightly", "3.2 MB · By you · 1 large file left out", or the whole reason a run failed), and the time in mono.

## Calm

- **Every line keeps its box.** The state, the next line, the button, the key's text, the fingerprint and the line under the field are words that take turns in one place (`pb-swap`): all candidates are laid out in the same cell, only the shown one is seen and read out, so each box has the size of its longest words and the new words fade in where the old ones were. The state keeps room for every kind of time ("Last night at", "Yesterday at", "Today at", "28 Nov at") and a slightly larger file. Before a key is saved the well keeps the room the fingerprint will take.
- **A new run is added at the bottom of Recent backups**, which is the last thing on the page: nothing he reads moves when a backup starts or ends, not even the rows of the list. The new line fades in without travel; lines shown before do not arrive again. A run that leaves the engine's list of 14 stays where it stands while the page is open, marked "No longer kept", so nothing below it moves up.
- **Every line of the section has its place in every state**: no key, key, running, checking, saved, unconfirmed, failed, folder problem. The line beside "Back up now" keeps the room of the engine's longest answer, and the folder's problem line its own, so a run that finds the folder gone moves nothing below.
- No spinner, no progress bar: "Backing up" is a word.

## The settings window (step 7b, 14 Nov 2026)

Since step 7b the page above is the **General** section of one settings window, as in T3 Code. Its words are "Settings", "General", "Chats", "Providers", "Usage", "Activity", "usage hub", "update". Never "thread" (a chat is a chat), "provider health check", "compaction" or "management API" in the window.

- **The way in** is the icon row at the very foot of the roster (`pb-foot-icons`): the gear (`pb-foot-settings`, a gear that stands still; the small quiet dot `pb-foot-dot` while no backup key is saved, read out as "Settings, backup not set up"), the bars (`pb-foot-usage`, opens the window on Usage), and at the right a round arrow on a raised disc (`pb-foot-update`) only while Claude Code or Codex has an update or one runs. The arrow's place is kept when it is not there, so the row never moves. No pull requests. In a roster of faces (below 900 px) the icons stand under each other; on a phone they are 44 px each at the foot of the Bots screen. The old "Pobots settings" line is gone.
- **On a computer** a window over the app (`pb-setwin`, on the dimmed layer): its size is set by the app window (at most 920 by 720), never by the section, so changing sections moves nothing. The head is the gear on a soft disc, "Settings", "For the whole app, not one bot" and a close control (X, "Close settings"). The sections are listed on the left (`pb-setwin-tab`, a tab list; the arrow keys move along it). What is under the window stays where it is, out of reach. Escape closes it, also when the control that had the focus went away; the focus goes back to what opened it. Tab stays inside.
- **On a phone** a full-screen sheet as before, the sections as a row of tabs under the head, each 44 px.

### Chats

"When chats start fresh": one sentence on what a fresh start is, a choice "Claude bots" / "Codex bots", then "Fresh starts" (a switch) and the values, each a row (`pb-set7-row`): its name and one muted sentence at the left, the number field and its unit at the right, "Default: 100,000 tokens" under it (with "(in use)" while it is the default) and a quiet **Reset** that keeps its room while it is not needed, and a line that keeps its room for a refusal. A value saves when the field is left or with Enter. "Before the cache runs out" is greyed for Codex bots, saying why. Then "Chat titles": what a title is for, "Made by" (the Claude models and, while Codex is ready, the ChatGPT models, in two groups named as in the bot picker; the chosen model's provider mark in a soft disc beside it, `pb-set7-model-mark`, which changes without anything moving), and that only the start and the end of a chat are sent. A ChatGPT model names chats through Codex; the hint says Haiku 5.5 does it when Codex cannot.

### Providers

"Providers": which machine, "Checked 4 min ago." and **Check now**. A card per provider (`pb-set7-provider`): its mark, name and on/off switch; "Version 0.165.0 · Signed in · Installed with its own installer"; "Version 0.169.0 is out." with **Update** (its room kept when there is none), or "Up to date."; the program's path in quiet mono. A provider a bot runs on cannot be switched off; the line under the card says which bots. Under the cards the last update in one line. "How often Pobots looks": seconds, 300 by default, 0 never. "Usage hubs": the hubs added (address, "CLI Proxy · Key kept on this Mac" or "Key read from 1Password", **Remove**), then "Hub address", "Management key" (a password field: what is typed is hidden, and the key is never shown again) and **Add hub**.

### Usage

"From Claude Code and Codex on this Mac." or "From <hub>." with when, and **Refresh**. Per provider (Claude, Codex) a row per limit window (`pb-set7-meter`): its name (Session, Weekly, Weekly · Fable, Monthly spend) and what is left in big ("82% left"; with several accounts the average), then a bar per account (`pb-set7-bar`): with several accounts its two letters in a soft disc first, the share left, the reset time ("resets in 3 h 24 min"). A bar with 15% or less left is filled in `clay`; the number says it too. Reading again keeps everything in place (the meters dim while reading).

### Activity

The last section, after Usage (17 Nov 2026, engine 0.30.0): one day of what happened in Pobots, read only, times and labels only. Previous day, the day's name, Next day and Today in a head that never moves; "Read at 14:02." with **Refresh**; a short summary; the rows. See **ActivityDay**. On a phone the row of tabs brings the chosen tab into view.

### The update dialog

The arrow (and **Update** on a card) asks first: "Update Codex?", "Codex 0.165.0 to 0.169.0", "Pobots waits until your bots are done, updates, and restarts their Codex. Pobots itself keeps running.", **Not now** and **Update**. Then the run in one line that changes in place ("Waiting for Inbox to finish.", "Updating Codex.", "Restarting the bots' Claude Code and Codex.") and "It goes on if you close this.", and at the end "Update done" with "Codex updated from 0.165.0 to 0.169.0." (or "Update did not finish" and what the program said).

## A bot's own choice (step 7b)

In a bot's Settings tab, after Access: "When Kaja is working", a choice list: "Pobots default (Steer)" (named with what the default is now), "Steer", "Queue", with the same hints as the General section. It saves at once.

## Calendar (16 Nov 2026)

A section of the settings window, between Providers and Usage. **Calendar**: one paragraph on what it is ("Bots with the calendar tools use your Outlook calendar through a flow in your Power Automate. ..."), then the state line as a channel's address for answers has it (a check and "Connected to Robin Example (robin@example.com).", the idle ring and "Not set up yet.", or the blocked mark and the problem in plain words), "Checked 3 min ago." with a quiet **Check the connection** (it says "Checking now." in the same room), then the address field: "The flow's address" with **Save**, once set "Replace the flow's address with" with **Replace** and **Remove** (danger, asks first: "Remove the calendar's address?"). The address is never shown again and the field is empty after saving, as a `SecretField`. **Inside the company**: the email domains, one field with **Save** and, once set by hand, a quiet **Use the mailbox's**; the hint says where they come from ("From your mailbox's address." or "Set by you.").

In a bot's Settings tab, after May steer: **Calendar**, a switch "Calendar tools" with its hint, on for the main bot and off for the others by default. While the calendar is not set up a line says so with a quiet **Set up the calendar**, which opens the settings window on Calendar.
