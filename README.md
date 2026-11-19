# Pobots

A desktop home for persistent bots. Each bot is a long-lived helper with its own job, memory, files, tools and chat. You talk to your bots in one app; they work on your computer, wake on schedules and webhooks, hand work to each other, start helpers for bigger jobs and ask you on a card when they need a decision.

Bots run on the official agent harnesses: Claude Code through the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript), and Codex with the GPT models through `codex app-server`.

**Your own accounts.** Pobots does not sell or proxy model access. It drives the Claude Code and Codex you have already installed and signed in to, so each bot's work counts against your own Claude plan or API key, or your own ChatGPT plan for GPT bots.

## Status

Pobots is a personal tool, built by one person for their own Mac and used every day there. It is shared as it is. Expect rough edges, and expect things to change without notice.

- **Tested on:** macOS on Apple silicon, with the app window also opened in Chrome on another computer and on phones over Tailscale.
- **Not tested:** Intel Macs, Windows and Linux. The engine and the window are plain Node and web code and may well run there, but the background service (launchd), some defaults (folders under `~/Library`) and a few tools assume macOS.
- There are no releases or installers. You run it from the source.

## What you need

- macOS and [Node.js](https://nodejs.org) 24 or newer, with npm.
- [Claude Code](https://docs.claude.com/en/docs/claude-code), installed and signed in (`claude` works in a terminal). Pobots finds it in the usual places, or set `claude.executable` in `config.json`.
- Optional, for bots on GPT models: [Codex](https://github.com/openai/codex), installed and signed in with your ChatGPT account (`codex` works in a terminal).
- Optional, for encrypted nightly backups: [restic](https://restic.net/) (`brew install restic`) and the 1Password CLI. See [the backup setup](docs/backup.md).
- Optional, to open Pobots from your other devices and your phone: [Tailscale](https://tailscale.com).

## Install and start

```sh
git clone <this repository> pobots
cd pobots
npm install
npm start
```

`npm start` builds the app and opens its window. The window starts the engine (the part that runs the bots) and stops it when you quit. On first start Pobots makes:

- its data folder, `~/Library/Application Support/Pobots` (the database, `config.json`, logs),
- its bots folder, `~/Pobots/bots`, with one folder per bot (its job description, memory and files),
- nothing else.

The window then shows one screen, "Welcome to Pobots": name your main bot (it says Po until you change it), pick its model, and create it. The main bot can make and change your other bots for you. It starts by itself: it greets you and asks a few questions, a couple at a time, about who you are, what you do, what matters to you, your responsibilities and how you like to be talked to. From your answers it writes a short note, "About you", that every bot gets. You can read and change it in Settings, General, About you, or ask the main bot to change it. Pobots keeps the note in its database on your Mac and never writes it to a log; the bots read it with their instructions.

`npm run deps` instead of `npm install` keeps the packages in another folder (`POBOTS_DEPS_DIR`, by default `~/.local/share/pobots`) and links them in. It is only useful when the repository sits on an external or synced drive.

### Run it in the background

To keep the bots working with the window closed, install the engine as a macOS background service (a launchd agent that starts at login):

```sh
npm run service:install     # build, copy the build to ~/.local/share/pobots, start it
npm run service:status
npm run service:uninstall
```

`npm start` then joins the running service instead of starting its own engine.

## Updating

Press Update in Pobots when it says a new version is available. A round arrow comes at the foot of the list of bots, and Settings, Providers says "Pobots 0.34.1 is available". Pobots then waits until your bots are done, brings the new version into this folder, builds it beside the running one, and restarts. The window comes back by itself after about a minute. If the new version does not start, the version before comes back, with your data as it was.

Pobots looks for a new version at start and every four hours, with a plain `git fetch` from this repository (no account or token). It updates only when this folder has no changes of its own and can move forward without a merge; otherwise it says so and changes nothing. It restarts itself when it runs from `npm start` or as the background service. Started another way, it shows that a new version is out, and you update with `git pull` and `npm start`.

## Settings

Most settings are changed in the app (the settings window) or by asking the main bot. [Connections](docs/connections.md) lets two main bots exchange messages. A few that belong to the machine live in `config.json` in the data folder. All of them are optional. See [docs/configuration.md](docs/configuration.md).

## Safety

Pobots gives AI agents real access to your computer. Read this before you use it.

- **Bots act as you.** A bot can read and write files, run commands and use the services you have signed in to in Claude Code or Codex. Each bot's settings say how much it may do without asking; "full access" means no questions. Start with the defaults and give more only to bots you trust with it.
- **Remote access is off by default.** The engine listens on `127.0.0.1` only. Other devices can open Pobots only when you list their Tailscale login in `remote.allowedLogins` and publish the port on your own tailnet with `tailscale serve`. Never expose the engine's port to the internet.
- **Messages are data.** Webhooks, channel messages, emails and web pages a bot reads can contain instructions. Bots are told to treat them as data, but no model is perfect: be careful with what you connect.
- **Secrets.** Keep keys in a password manager. Where Pobots asks for a key, it also takes a 1Password `op://` reference, read with the 1Password command line when used.

Found a security problem? See [SECURITY.md](SECURITY.md).

## Development

```sh
npm run typecheck
npm test              # the engine's tests, no model calls
npm run check:ui      # the window against its built-in sample data, in a headless Chromium
```

The checks use chrome-headless-shell from the Playwright cache (`npx playwright install chromium-headless-shell`), or the binary named in `CHROMIUM`. `check:engine`, `check:app` and `check:remote` also make a few small real model calls on the cheapest model. Code layout and the rules for changes are in [AGENTS.md](AGENTS.md); how the app looks and speaks is in [design-system/](design-system/).

## License

Made by Rasmus Driving. [MIT](LICENSE). Pobots builds on the Claude Agent SDK, which is Anthropic's and comes under its own terms as an ordinary npm dependency. Claude Code, Codex, Tailscale and the other tools Pobots works with are their makers' own.
