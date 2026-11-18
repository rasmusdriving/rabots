An approval card asks the person to allow or deny one action a bot wants to take.

You provide the bot, the question as one sentence, the exact thing that will happen (the draft, the command, the change), and when the request expires.

- Always show exactly what will be done, in a `pb-draft` well. Never ask for approval of something the person cannot see. A long text is cut with a soft fade and a quiet "Show all" under the well; it never scrolls inside the well.
- The three choices are fixed and in this order: "Allow once" (primary), "Always allow" (secondary), "Deny" (quiet).
- "Always allow" saves a rule. Say which rule in a line that appears after the choice, with an undo.
- A card from background work (a turn another bot started) carries its expiry in the foot, said gently: "Expires in 28 min". The line keeps itself current. When it expires it leaves without fuss, a short fade and the gap closes, and the bot is told it was not allowed.
- Some requests can only be allowed once: creating, changing or retiring a bot. Those cards show only "Allow once" and "Deny".
- Use this card only for permission. For a choice between options, use the needs-you card.

Changes to a channel that the main bot asks for (a tag that reaches another bot, who may write) are ordinary approval cards with only "Allow once" and "Deny" (`noAlways`): these changes decide who can instruct a bot, so they are never silent. The detail keeps its line breaks, so a card that lists writers reads as one line per address: who is added, who is removed, and who may write afterwards. Addresses break anywhere, so a long one never leaves the well.


**A helper's card (14 Nov 2026, step 7c).** When one of the bot's helpers asks (the bot is on "Asks first" or "Edits freely"), the card says which helper under the head, quietly, in line with the bot's name: "For its helper Fix notifications review findings" (`pb-card-helper`, 12/16 `ink-faint`, one line with an ellipsis). A bot on "Full access" and its helpers never raise this card; on "Decides itself" a helper never does.

**A meeting card (16 Nov 2026, the calendar tools).** When a bot books, moves or cancels a meeting with other people, or answers an invitation, the card writes the meeting out in the well under the caption "Calendar" (`pb-meet`): the subject in weight 600; the time in the meeting's time zone ("Wed 18 Nov 10:00 to 11:00", the zone named only when it differs from the window's); for a move "To ..." and below it "Now ..." in `ink-muted`; a clash in the person's own calendar in `amber` ("You have something else then: Lunch (12:00 to 13:00)"); who sent an invitation ("From Sam Berg <sam@partner.example.org>"); one line per person with the name, the address in mono `ink-faint`, and a tag in 12/18 `ink-muted`: "Internal, free then", "Internal, could not be checked" (in `amber`), "External, the agreed time"; the Teams line ("Teams meeting, a link is added", "Teams meeting", "No Teams link"); and the text or message under a small label, keeping its line breaks. Titles: "Book this meeting?", "Move this meeting?", "Cancel this meeting?", "Accept this invitation?", "Accept this invitation as tentative?", "Decline this invitation?".

- The choices are **Approve** (primary) and **Deny** (quiet), never "Always allow": every meeting with other people is asked about, on every access level.
- The meeting well is cut later than other wells (360px instead of 240px) with the same soft fade and "Show all", so a normal meeting reads whole.
- Addresses break anywhere; nothing in the card reaches past it on a 360px phone.
