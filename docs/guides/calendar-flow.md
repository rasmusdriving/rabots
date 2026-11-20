# Set up the calendar flow

This guide connects Pobots to a person's own Outlook calendar through a flow in their own Power Automate. It is written for a bot to go through together with its person, and a person can follow it alone. The flow's definition is in [flows/calendar.definition.json](flows/calendar.definition.json), next to this file.

For Google Calendar, see [google-calendar.md](google-calendar.md) instead.

Pobots works without it. Without the flow, the bots have no calendar tools, Ahead shows no meetings, and to-dos do not get blocks in the calendar. Everything else works as before.

## What it gives

With the flow set up, a bot whose Calendar switch is on gets these tools:

- `calendar_list`: what is in the calendar between two times.
- `calendar_free_times`: when people inside the company are free.
- `calendar_create`, `calendar_move`, `calendar_cancel`: make, move or cancel a meeting. Every meeting is a Teams meeting.
- `calendar_respond`: answer an invitation (accept, maybe, decline).

A meeting with other people, and every answer to an invitation, goes on the person's card first and only happens when they approve. A block in their own calendar with nobody else needs no card.

It also turns on two things in the window: meetings on Ahead, and, in Settings, Ahead, "To-dos in your calendar" (a to-do with a time gets a block in the calendar).

The main bot has the Calendar switch on from the start. For other bots it is in each bot's Settings, or the main bot switches it with `update_bot`.

## What the person needs

- **A Microsoft 365 work or school account** with an Outlook mailbox. The flow acts on that account's own calendar (`/me`), nobody else's.
- **Power Automate with premium connectors.** The trigger "When an HTTP request is received" is a premium trigger. A plan that has only standard connectors cannot save or run it. If the person is not sure, they open Power Automate, make a new instant flow and look for the trigger: it is marked Premium, and a plan without it says so.
- **An Office 365 Outlook connection** in Power Automate, signed in as the person themselves. The flow uses its action "Send an HTTP request", which calls Microsoft Graph on `/me`.
- **Pobots** at engine 0.25.0 or later.

The calendar flow does not need a public address for Pobots. Pobots calls the flow; the flow never calls Pobots.

## Without premium

Check this first, before anything is built. Without Power Automate premium the flow cannot be saved or run, and there is no other way for Pobots to reach an Outlook calendar. Then:

- The bots have no calendar tools, and Ahead shows no meetings or free time. Ahead's own to-dos and everything else in Pobots work as before.
- The person can ask their IT for a Power Automate plan with premium connectors (for example Power Automate Premium per user). Whether they get one is their organisation's decision.
- A person who uses Google Calendar instead follows [google-calendar.md](google-calendar.md), which needs no paid plan.

## Set it up

About 20 to 30 minutes. The steps in Power Automate are done by the person, or by a bot that drives the browser while the person watches. Signing in and approving the connection are always the person's.

1. **Make the flow.** In Power Automate, make an instant cloud flow, for example "Pobots - calendar", with the trigger **When an HTTP request is received**. Set its method to POST and who can trigger it to anyone (the address itself is the key). Give it the request body schema `{ "type": "object", "properties": { "action": { "type": "string" } } }`.
2. **Three variables.** Add three "Initialize variable" actions, all of type String with no value: `method`, `uri` and `body`.
3. **Pick the request.** Add a **Switch** on the expression `triggerBody()?['action']`, with one case for each of `hello`, `list`, `get`, `create`, `move`, `cancel`, `delete`, `respond` and `schedule`. In each case, set the three variables exactly as the definition's case of the same name does (copy the values from [the definition](flows/calendar.definition.json); they are long). In short:

   | case | method | address (after `https://graph.microsoft.com/v1.0`) | body |
   | --- | --- | --- | --- |
   | `hello` | GET | `/me/calendar?$select=id,name,owner` | none |
   | `list` | GET | `/me/calendar/calendarView?startDateTime=...&endDateTime=...&$top=100&$orderby=start/dateTime&$select=...` | none |
   | `get` | GET | `/me/events/{id}?$select=...` | none |
   | `create` | POST | `/me/events` | the request's `event`, unchanged |
   | `move` | PATCH | `/me/events/{id}` | only `start` and `end` |
   | `cancel` | POST | `/me/events/{id}/cancel` | `{ "comment": ... }` |
   | `delete` | DELETE | `/me/events/{id}` | none |
   | `respond` | POST | `/me/events/{id}/accept`, `/tentativelyAccept` or `/decline` | `{ "comment": ..., "sendResponse": true }` |
   | `schedule` | POST | `/me/calendar/getSchedule` | `schedules`, `startTime`, `endTime`, `availabilityViewInterval` |

   Every `{id}` goes through `encodeUriComponent`. The **Default** case answers with a Response of status 400 and body `{ "ok": false, "message": "No case for this action." }`, then a Terminate. The connector allows only `/me/calendar/...` and `/me/events/...` style paths, which is why `list` and `schedule` go through `/me/calendar`.
4. **Call Outlook.** After the Switch, add the Office 365 Outlook action **Send an HTTP request** with Uri `variables('uri')`, Method `variables('method')`, Body `variables('body')`, Content-Type `application/json`, and the header `Prefer: outlook.timezone="UTC"`. In its settings, **turn retries off** (Retry policy: None): otherwise the connector retries a slow answer up to four times, which can make a meeting twice. Turn on secure inputs and secure outputs, so the run history does not show meeting contents.
5. **Answer Pobots.** Add a **Response** after the HTTP action that runs when it succeeded: status 200, body `{ "ok": true, "result": <the HTTP action's body, or null when empty> }`. Add a second **Response** that runs when the HTTP action failed or timed out (Configure run after: has failed, has timed out): status 502, body `{ "ok": false, "graphStatus": <the HTTP action's status code, or 504>, "message": <the error message from Outlook> }`. The exact expressions are in the definition.
6. **Save the flow.** The trigger now shows its address, **HTTP URL**. Copy it. It is a secret: see "The address is a secret" below.
7. **Give the address to Pobots.** In Pobots: Settings, Calendar, "The flow's address". Paste it and press Save. Pobots checks it at once.

A bot that drives the browser can also save the whole definition through Power Automate's own page while the person watches, instead of steps 2 to 5. That is how the first flow was made. The definition holds no addresses, names or tenants, so it can be used as it is; the connection is the person's own.

## Check that it works

1. After Save, Settings, Calendar says **Connected to** and the mailbox's name and address. If it names someone else's mailbox, the Outlook connection is signed in as the wrong account: remove the address and fix the connection.
2. **Check the connection** in the same place runs the check again at any time.
3. Ask the main bot to list today's meetings. It uses `calendar_list`.
4. Ask the main bot to block 15 minutes tomorrow, with nobody else. Look in Outlook that the block is there, then ask the bot to move it and to remove it. Nobody else is invited, so nothing reaches anyone.
5. In Power Automate, the flow's run history shows one run for each call. A call that Outlook refused shows as a failed run, even though the flow answered Pobots.

The main bot's `get_settings` also says whether the calendar is set up, which mailbox it acts for, and the last problem, if any.

## What Pobots says when something is wrong

Pobots waits 30 seconds for the flow and never tries the same call twice by itself.

| Pobots says | What it means | What to do |
| --- | --- | --- |
| "The flow answered, but did not say which mailbox it acts for" | The `hello` case answered without the calendar's owner. | Compare the `hello` case with the definition. |
| "The calendar flow refused it (status 400). It likely has no case for ..." | The Switch has no case for that action, so its default answered. Nothing changed. | Add the missing case from the definition. |
| "The calendar flow said no (status ...)" | Another 4xx: the flow is off, or the address in Pobots is not the flow's current one. | Turn the flow on, or copy the address again and replace it in Settings, Calendar. |
| "The calendar flow failed (status ...)" | The flow itself failed. For a change, it may still have happened. | Look at the run history. Look in the calendar before trying again. |
| "The calendar flow answered in a way Pobots does not know" | A 2xx without `ok: true`. | Compare the Response actions with the definition. |
| "The calendar flow did not answer within 30 seconds" | No answer in time. For a change, it may still have happened. | Look in the calendar before trying again. |
| "The calendar flow could not be reached" | No connection at all. Nothing happened. | Check the internet, then try again later. |
| "Outlook did not allow it (status 401 or 403)" | The Outlook connection is signed out or lacks the right. | Sign the connection in again in Power Automate. |
| "That meeting is not in the calendar (any more)" | Outlook answered 404. | Look again with `calendar_list`. |
| "Outlook asked to slow down (status 429)" | Too many calls. The connector allows 300 a minute. | Wait a minute. |
| "Outlook failed (status 5xx)" | Outlook itself failed. For a change, it may still have happened. | Look in the calendar before trying again. |
| "Outlook refused it (status ...)" | Any other refusal, with Outlook's own words after it. | Read Outlook's words; often a time or an address is wrong. |

"Not set up" (in Settings, Calendar, in `get_settings` and `get_bot`, and in a bot's instructions) means no address is saved yet.

## Change it or remove it

- **A new address** (for example after the flow was copied, or its trigger made again): Settings, Calendar, "Replace the flow's address with", paste, Save.
- **Which bots have the tools**: each bot's Calendar switch, in its Settings, or ask the main bot (`update_bot`, `calendar`).
- **Which addresses count as inside the company** (used to check who is free): the main bot's `change_settings` with `calendar_internal_domains`. By default it is the mailbox's own domain.
- **Remove**: Settings, Calendar, Remove. The bots lose the calendar tools at once. Nothing in the calendar changes. Turning the flow off in Power Automate stops it too; Pobots then reports that the flow said no or could not be reached.
- **A change to the flow** in Power Automate keeps its address, so Pobots needs nothing new.

## Who does what

A bot may:

- Read this guide and the definition, and go through the steps with the person.
- Tell the person what to click, and explain what a step does.
- Drive the browser in Power Automate while the person watches, when the person asks for that, on a page where the person is already signed in.
- After the address is set: check it with `get_settings`, list today's meetings, and make, move and remove a test block in the person's own calendar with nobody else.

Only the person:

- Signs in to Power Automate and to the Outlook connection, and approves anything Microsoft asks for.
- Decides on the plan or licence, and anything their organisation's admin must allow.
- Sets, replaces or removes the address in Pobots. The main bot cannot set it; there is no tool for it.
- Approves every meeting with other people and every answer to an invitation, on their card.

## The address is a secret

The trigger's address carries a signature that lets anyone who has it read and change the calendar through the flow. Treat it like a password.

- It never goes into chat, a bot's message, a tool, a file, a note or a log. A bot never asks for it.
- The person copies it from Power Automate and pastes it into Settings, Calendar. Or a bot that drives the browser while the person watches carries it from Power Automate's page straight into Pobots' settings, without writing it anywhere.
- Pobots keeps it in its own database on the Mac, never shows it again (the field says "The address is set. It is not shown again."), and never writes it in a log.
- If it may have leaked: in Power Automate, delete the trigger and add it again (or copy the flow) to get a new address, and replace it in Pobots.

## Things to know

- **The whole event passes through.** For `create`, the flow sends the request's `event` to Outlook unchanged. What Pobots puts in it reaches Outlook as it is: a meeting gets a Teams link (`isOnlineMeeting`, `onlineMeetingProvider`), and a to-do's block is marked busy with no reminder, no Teams link and nobody invited. The flow needs no change for either.
- **Times.** Pobots sends the times of a new or moved meeting in the person's own time zone; the flow passes them through. Everything read back is UTC, because of the `Prefer` header, and Pobots shows it in the person's zone.
- **Free and busy of colleagues** comes from Outlook's `getSchedule` through the same connection. Whether it shows a colleague's times depends on the organisation's settings; this was not checked on more than one tenant.
- **Not checked yet**: whether an empty body on a DELETE is accepted in every tenant.
- These steps were written from the definition and from Pobots' code. They were not walked again in a fresh Power Automate account when the guide was written.
