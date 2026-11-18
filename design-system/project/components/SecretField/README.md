An address the app writes but never reads back: the address a channel's answers are posted to. It is a secret, so the engine only says whether one is set (`hasReplyUrl`).

- **State** (`pb-reply-state`): a quiet check and "An address for answers is set. It is not shown again." in `ink`, or the idle ring and "No address for answers yet." in `ink-muted`.
- **Field**: a password-style field in a well (`pb-secret-input`, `font-mono`): what is typed is drawn as dots. It is a text field, not `type="password"`, so a browser's password manager neither fills it with a saved password nor offers to save the address, labelled "Address for answers", or "Replace it with" once one is set, and a small "Save" or "Replace". Enter saves too. Once saved the field is emptied and "Saved" shows beside the title for a moment. The address is never put back in the field, on the page or in the window's state.
- It must start with `https://` (the engine also takes `http://127.0.0.1` and `http://localhost`, for tests); otherwise one line in clay says so and nothing is sent.
- **Remove** (clay, quiet) asks first: "Remove the address for answers?" and "Bots still read messages from here, but their answers are no longer posted in the channel."
- One line under the field: without it, bots read messages from here but cannot answer there, and where the address comes from.
