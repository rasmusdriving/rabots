Three motions cover the whole app: arrive, breathe and respond.

- **Arrive** (`pb-arrive`): a new message, card or panel fades in and rises 6px over `dur-calm` with `ease-out`. Leaving takes `dur-quick` and does not travel.
- **Breathe**: the Working mark's halo swells and fades once every `dur-breath` with `ease-breath`. The Thinking dots rise 2px in turn. A bot's eyes drift while it thinks and blink while it works or waits. These are the only loops, and they all belong to bots.
- **Respond**: a press scales to 98% in `dur-instant`. Hover, focus and switches change over `dur-quick` with `ease-soft`.

Rules:

- If a motion does not tell the person something, remove it.
- Never animate to get attention. Waiting is shown by a still amber mark.
- Never move something the person is reading or about to click.
- Stagger a group by at most 40ms per item and at most five items.
- With reduced motion on, loops stop and arrivals become a short fade.
