# Pobots: notes for contributors and coding agents

Read `README.md` first: what Pobots is, how to run it and what it assumes. Settings that belong to the machine are in `docs/configuration.md`.

Pobots is a personal tool for one person on their own machines. Do not add accounts, logins or multi-user features.

## Code

- TypeScript throughout. Electron for the app window, one Node engine that also runs on its own.
- `shared/protocol.ts` is the contract between the app and the engine, and the only place they meet.
- `engine/` is the engine. `engine/engine.ts` holds the `Engine` class, its state and the protocol's methods; each part of what it does is a file in `engine/core/`, as functions that take the engine as `eng`.
- A bot runs on one of two harnesses, decided by its model: Claude Code (`engine/claude/`, through the Claude Agent SDK) or Codex with the GPT models (`engine/codex/`, through `codex app-server`). Both are the person's own installs and logins: Pobots never changes `~/.claude` or `~/.codex`.
- `ui/` is the app window, `desktop/` the Electron shell, `scripts/` the build, install and check scripts. `ui/engine/` is a stand-in engine with sample data that the window check runs against.
- Keep files small enough to read in one go. A new feature gets files of its own (its own module, its own section in the checks) instead of growing the end of a long file. No file grows past about 1,500 lines.
- Never put secrets in the repository, in logs or in chat. Where a key is needed, a 1Password reference works.

## Build and checks

- `npm install` (or `npm run deps`, which keeps the packages in another folder and links them in; see `README.md`).
- `npm run build`, or one part: `npm run build:engine`, `build:ui`, `build:desktop`. `npm start` opens the window.
- `npm run typecheck` and `npm test` (the engine, no model calls) before every change.
- `npm run check:ui`: the window against the stand-in engine in a headless Chromium. One section alone: `node scripts/ui-check.mjs --only=<section>` (`--sections` lists them). The sections are files in `scripts/ui-check/sections/`; a new section is a new file there and its name in `SECTIONS` in the `lib.mjs` beside them.
- `npm run check:app`, `check:engine` and `check:remote` start a real engine on temporary folders and make a few small real model calls on the cheapest model. `scripts/app-check/` is laid out like the window check.
- `scripts/service.mjs` installs the engine as a macOS launchd agent. `scripts/live-update.mjs` and `scripts/testbed.mjs` update that background service safely and run a second test install beside it; they assume a Mac set up like the maintainer's and are not needed to run Pobots.

## Design

- `design-system/project/` is the source of truth for how the app looks, moves and speaks. Read `design-system/project/README.md` before building a screen.
- Use tokens, never literal colours, sizes or durations. Build the CSS variables with `node design-system/build.mjs`.
- App words: plain and short, sentence case, no exclamation marks, no emoji, no long dashes.
- A person never needs a file explorer or an outside editor to manage a bot: everything about a bot is edited in the app.
- Things that change on screen keep their place: a line that changes keeps its box, a panel that opens keeps the chat where it was, motion is calm.
- Do not call the app or any part of it "Claude Code", and do not copy Claude Code's look.
