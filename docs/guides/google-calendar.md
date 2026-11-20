# Set up Google Calendar

This guide connects Pobots to a person's own Google Calendar through a small script in their own Google account. It is written for a bot to go through together with its person, and a person can follow it alone. The script is [google/calendar.gs](google/calendar.gs) and its settings file is [google/appsscript.json](google/appsscript.json), next to this file.

It does the same as the calendar flow for Outlook ([calendar-flow.md](calendar-flow.md)): Pobots sends it the same requests and reads the same answers. A person uses one or the other, not both.

Pobots works without it. Without a calendar, the bots have no calendar tools, Ahead shows no meetings, and to-dos do not get blocks in the calendar. Everything else works as before.

## What it gives

The same tools as with Outlook, for a bot whose Calendar switch is on: `calendar_list`, `calendar_free_times`, `calendar_create`, `calendar_move`, `calendar_cancel` and `calendar_respond`. Ahead shows the meetings, and "To-dos in your calendar" can be switched on in Settings, Ahead.

Every meeting a bot books gets a Google Meet link. A meeting with other people, and every answer to an invitation, goes on the person's card first and only happens when they approve.

## What the person needs

- **A Google account with Google Calendar**, personal or Google Workspace. The script acts on that account's own main calendar, nobody else's.
- **Apps Script** (script.google.com), which every Google account has. A Google Workspace admin can turn off scripts that anyone may call; then the web app cannot be deployed for "Anyone", and the person asks their admin.
- **Pobots** at engine 0.42.0 or later.

Nothing to pay for. Pobots calls the script; the script never calls Pobots.

## Set it up

About 10 minutes. The steps in Google are done by the person, or by a bot that drives the browser while the person watches. Signing in and allowing access are always the person's.

1. **Make the script.** Open script.google.com, signed in as the person, and press **New project**. Name it, for example "Pobots calendar".
2. **Paste the script.** Replace everything in `Code.gs` with the text of [google/calendar.gs](google/calendar.gs). A bot gives the person the text in the chat to copy.
3. **The settings file.** In **Project Settings**, tick "Show appsscript.json manifest file in editor". Open `appsscript.json` in the editor and replace it with [google/appsscript.json](google/appsscript.json). This turns on the Google Calendar service the script uses and lets only Pobots' key in.
4. **Make the key.** Pick the function `setup` at the top of the editor and press **Run**. Google asks for access to the calendar: the person reviews it and allows it. (For a script that is not verified by Google, it shows a warning; the person chooses Advanced, then goes to the project, since it is their own.) The log then shows a line that ends with `?key=` and a long key.
5. **Deploy.** Press **Deploy**, **New deployment**, type **Web app**. Execute as: **Me**. Who has access: **Anyone**. Press **Deploy** and copy the **Web app URL** (it ends with `/exec`).
6. **The address.** Put the end of the log's line (`?key=...`) right after `/exec`. The whole address is a secret: see "The address is a secret" below.
7. **Give the address to Pobots.** In Pobots: Settings, Calendar, "The flow's address". Paste it and press Save. Pobots checks it at once and knows from the address that it is Google Calendar.

## Check that it works

1. After Save, Settings, Calendar says **Connected to** and the account's address.
2. Ask the main bot to list today's meetings. It uses `calendar_list`.
3. Ask the main bot to block 15 minutes tomorrow, with nobody else. Look in Google Calendar that the block is there (with a Google Meet link), then ask the bot to move it and to remove it.
4. In Apps Script, **Executions** lists one run for each call.

## What is different from Outlook

- **Cancel**: Google tells the guests the meeting is cancelled, but has no place for a message, so the bot's message is not sent.
- **Answer an invitation**: the answer goes back with the message as its note.
- **Free times of colleagues**: Google shares them only for people in the same Google Workspace, or who share their calendar. Someone it cannot read shows as "could not be read".
- **Teams**: none. Every online meeting is Google Meet.
- **Times**: Pobots sends its own time zone with every request, so meetings land at the right time whatever the script's zone.

## What Pobots says when something is wrong

Apps Script always answers with status 200, so Pobots reads Google's own no inside the answer.

| Pobots says | What it means | What to do |
| --- | --- | --- |
| "Google Calendar did not allow it (status 401)" with "The key at the end of the address is not this script's key" | The key in the address is wrong or was made new. | Run `setup` again, copy the key, and replace the address in Settings, Calendar. |
| "Google Calendar did not allow it (status 403)" | The script lost access to the calendar. | Run `setup` once in the editor and allow access again. |
| "The calendar script said no (status ...)" | The web app is not deployed for Anyone, or the address is an old deployment's. | Deploy again (step 5) and replace the address. |
| "Google Calendar refused it (status 400)" with "The script has no case for this action" | The script is an older copy. | Paste the script again and deploy a new version. |
| "That meeting is not in the calendar (any more)" | Google answered 404. | Look again with `calendar_list`. |
| "Google Calendar asked to slow down (status 429)" | Too many calls. | Wait a minute. |
| "Google Calendar failed (status 5xx)" | Google failed. For a change, it may still have happened. | Look in the calendar before trying again. |
| "The calendar script did not answer within 30 seconds" | No answer in time. | Look in the calendar before trying again. |

## Change it or remove it

- **A change to the script**: paste it, then **Deploy**, **Manage deployments**, edit the web app and pick **New version**. The address stays the same.
- **Remove**: Settings, Calendar, Remove. Archive the deployment in Apps Script to stop the script too.

## Who does what

A bot may:

- Read this guide and the script, give the person the script's text, and go through the steps with them.
- Drive the browser in Apps Script while the person watches, when the person asks for that, on a page where the person is already signed in.
- After the address is set: check it with `get_settings`, list today's meetings, and make, move and remove a test block in the person's own calendar with nobody else.

Only the person:

- Signs in to Google and allows the script access to their calendar.
- Decides anything their Google Workspace admin must allow.
- Sets, replaces or removes the address in Pobots. The main bot cannot set it; there is no tool for it.
- Approves every meeting with other people and every answer to an invitation, on their card.

## The address is a secret

With the key, the address lets anyone read and change the calendar through the script. Treat it like a password.

- It never goes into chat, a bot's message, a tool, a file, a note or a log. A bot never asks for it.
- The person copies it from Apps Script and pastes it into Settings, Calendar.
- Pobots keeps it in its own database on the Mac, never shows it again, and never writes it in a log.
- If it may have leaked: run `newKey` in the script, copy the new key, and replace the address in Pobots. The old one stops working at once.

## Things to know

- The script was tested only against a stand-in for Google Calendar (`engine/tests/google-calendar.spec.ts`), not against a real Google account.
- The script keeps nothing but its key. Google keeps a short record of each run in Executions.
