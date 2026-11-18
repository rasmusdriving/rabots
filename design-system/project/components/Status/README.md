Status shows what a bot is doing right now, as a small mark and one word.

There are six states: Idle, Thinking, Working, Waiting, Blocked and Done. Each has its own shape, so the state can be read without colour.

You provide the state. The word comes with it: use `pb-status` with a `pb-mark pb-mark-<state>` inside, followed by the word. "Waiting" may be written "Waiting for you" where there is room. In a roster row the mark stands alone at the right end.

- Only Thinking and Working move. Done settles in once when it appears (`pb-settle`) and then is still. Waiting is still on purpose: it should feel like a note left on the desk, not an alarm.
- Thinking and Working use `accent-text`. Waiting uses `amber`, Blocked uses `clay`. Idle stays grey. Done is a check on a soft accent disc with its word in `ink`: it should catch the eye once, quietly, and then sit still.
- Do not add counts, badges or a second colour to a status.
- Do not invent new states. If a bot needs to say more, it says it in its one-line activity text.
- A turn the person stopped ends as Done with the activity "Stopped". The chat's header then says "Stopped" with Done's mark and tone, as the roster's line does; it is the one word that stands in for a state's own, not a seventh state.
- A finished job shows Done until the person has seen it, then returns to Idle. In a roster row add `data-state="done"` to the row, so its line is written in `ink` too.
- Inside a chat, a line of finished work uses the quiet grey check, `pb-mark-check`. The accent check is for the bot itself.
- Runs of a trigger reuse these marks and add none: done is the quiet check, running the working mark, failed the blocked mark, skipped the idle ring, nothing to report no mark (see RunList).
- Every mark is a filled or masked shape. The idle ring and the working halo are drawn rings, not 1.5px borders, because a fractional border smears at 125% and 150% screen scaling.
