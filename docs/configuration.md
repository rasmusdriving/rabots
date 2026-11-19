# Configuration

Most settings are changed in the app: in the settings window, on each bot's page, or by asking the main bot. What belongs to the machine lives in `config.json` in the data folder. Pobots writes the file with defaults on first start; every field is optional.

The data folder is `~/Library/Application Support/Pobots` on macOS. The engine and the desktop window take `--data-dir=PATH` and `--bots-dir=PATH` to run on other folders, for example a second Pobots for trying things out.

## config.json

| Field | What it does | Default |
| --- | --- | --- |
| `botsDir` | Where the bots' folders are | `~/Pobots/bots` |
| `machineName` | The name of this computer in the app | the computer's host name |
| `claude.executable` | The Claude Code command | looked for with a login shell, then in the usual install places |
| `claude.envFile` | A file of `NAME=value` lines added to the bots' Claude environment, for example to use a proxy | none |
| `codex.executable` | The Codex command, for bots on GPT models | looked for in the usual install places |
| `serve` | Serve the app window as a web page next to the engine's socket, on a fixed port (the background service turns this on) | off |
| `port` | The port in serve mode | `47600` |
| `remote.allowedLogins` | Tailscale logins that may open Pobots from other devices | empty: remote access is off |
| `publicBase` | The engine's address from outside, such as `https://host.example.net:10000`, used for webhook and Pobots connection addresses | none |
| `browser.enabled`, `browser.executable` | The bots' browser shown live in the app (see below) | on, command looked for in the usual places |
| `backup.folder`, `backup.time`, `backup.executable` | The nightly backup (see below) | see below, `03:00` |
| `notify` | Which notifications are sent to your devices | needs you and notes on, finished off |
| `updates.checkHours` | How often a clone of the public repository looks for a new Pobots (0 is never; Check now in Providers still looks) | `4` |
| `updates.source` | The clone Pobots updates itself from, when it cannot find it by itself | the clone it was built from |
| `updates.repo` | The repository a new version comes from; only a clone with this remote updates itself | the public repository |

Paths may start with `~`.

## What is optional

Pobots runs with only Claude Code installed. Everything below can be left out.

- **Codex and GPT models.** Bots on GPT models run through your own Codex install and ChatGPT login (`codex app-server`). Without Codex, bots on GPT models cannot run.
- **Tailscale, for your other devices and your phone.** Remote access is off until `remote.allowedLogins` lists a login. To use it, run Pobots as a background service (`npm run service:install`, which turns on serve mode), publish port 47600 on your tailnet with `tailscale serve`, and add your Tailscale login. The engine trusts the `Tailscale-User-Login` header that `tailscale serve` adds, and only from requests that come through it; it listens on `127.0.0.1` only. Webhooks can be reached from outside through Tailscale Funnel on the `/hook` path only; set `publicBase` to that address without the path. [Connections between Pobots](connections.md) reuse this door. Only one side needs a public address.
- **The bots' browser.** Bots can drive a browser on this computer through the `ego-browser` command (from the ego lite browser), and the app shows its pages live beside the chat. Without that command there is no browser to show; switch it off with `"browser": { "enabled": false }`.
- **The nightly backup.** Optional restic snapshots in iCloud Drive. The main data folder defaults to `~/Library/Mobile Documents/com~apple~CloudDocs/Pobots Backup`; any other data folder must name its own destination. Save a 1Password reference in Settings, General, Backup. See [the backup setup and restore steps](backup.md).
- **1Password.** Where Pobots asks for a key, an `op://vault/item/field` reference works too. It is read with the 1Password command line (`op`) when used and never stored.
- **The background service.** `npm run service:install` installs a macOS launchd agent that starts the engine at login and again after a crash. `--label`, `--port`, `--data-dir`, `--bots-dir` and `--install-dir` on `scripts/service.mjs` run a second one beside it. On other systems, run `node dist/engine/main.mjs --serve` with your own process manager (not tested).
- **Where packages live.** `npm run deps` installs the packages in `POBOTS_DEPS_DIR` (default `~/.local/share/pobots`) and links `node_modules` to it, for a repository on an external or synced drive. A plain `npm install` works too.
- **The checks' Claude environment.** `check:engine`, `check:app` and `check:remote` pass `POBOTS_CLAUDE_ENV_FILE` (default `~/.claude/cliproxy.env`, used only when it exists) to their engines as `claude.envFile`.
