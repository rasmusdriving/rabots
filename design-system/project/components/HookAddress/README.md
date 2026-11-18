An address that works like a password, a webhook's or a channel's, so it is shown only on request.

You provide a way to ask for it. Since step 2c the address is never part of a trigger or a channel the app holds: "Show address" asks the engine (`trigger.address` or `channel.address`) and gets the path ending in the secret, and the engine's public base address when one is set. The full address is the public base followed by the path; without one, it is the address the engine is reached on here (the page's own address in a browser, the engine the app connects to in the desktop app). The address is held only while shown.

- One plain sentence first: "Anyone with this address can wake Inbox. Keep it like a password."
- "Show address" reveals it in a well (`pb-address`), in `font-mono`, broken anywhere so it never runs out of the panel, with a quiet "Copy" beside it. Copy says "Copied" for a moment in the same place; the button keeps its width, so nothing moves.
- Under it, "Try it": a short example call (a `curl` line with a JSON body) in the same kind of well, also with "Copy".
- "Hide address" puts it away again. "New address" asks first ("Make a new address?"), says the old address stops working at once, and then shows the new one.
- Never log the address or put it anywhere but this well.
- A channel's address has no "Try it"; its page shows what the flow should send instead (see FlowExample). Its sentence says the Power Automate flow posts to it. Without a public base address, one hint under it says Power Automate can only reach it once Pobots has one.
- "New address" asks the engine for a new one (`trigger.newAddress`, `channel.newAddress`) and shows it.
