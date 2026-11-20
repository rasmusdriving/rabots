# Security policy

Pobots runs AI agents on your computer with wide access to it. A bot can read and write files, run commands, use a browser and reach the services you have signed in to. Pobots can also be opened from your other devices and your phone, as a web page, when you switch remote access on. A flaw in Pobots can therefore reach a lot. Please report it privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: on this repository's page, open **Security**, then **Report a vulnerability**. Please do not open a public issue, pull request or discussion about it, and do not disclose it publicly until it has been looked at and fixed.

A useful report says:

- what is affected (the engine, the app window, remote access, the artifact pages, webhooks, the backup, a bot tool),
- how to reproduce it, step by step,
- what an attacker could do with it,
- the Pobots commit or engine version you tested.

Pobots is maintained by one person in their own time. There is no bug bounty, and answers may take a while.

## What counts

In scope, for example:

- a way to open Pobots, its socket or its artifact pages from another device or web page without being allowed,
- a way for a web page, an artifact, a webhook, a message from a channel or another Pobots to make a bot act or to read what it should not,
- secrets (keys, tokens, the backup's private key) that end up in logs, files, the app or the network,
- a bot reaching past what its settings allow.

Out of scope:

- what an agent does with the access you gave it on purpose. A bot with full access can do anything you can; that is the design, so give access with care,
- flaws in Claude Code, the Claude Agent SDK, Codex, Tailscale, Electron or other software Pobots builds on. Report those to their makers.

## Safe use

- Remote access is off until you list a login in `remote.allowedLogins` in `config.json`. The engine listens on 127.0.0.1 only; other devices reach it only through `tailscale serve` on your own tailnet. Never put the engine's port on the open internet.
- Only the /hook path is meant to be reached from outside (through Tailscale Funnel, if you choose). It serves webhooks and [paired Pobots connections](docs/connections.md). Treat all incoming text as untrusted data. A paired connection sends outside text into the main bot's normal session, where it has memory, tools and its usual access. The message cannot answer approval cards or grant access, but a model can still be talked into sharing information or taking actions. Pair only with people you trust, and pause the connection to stop new messages. Since 0.44.0 a connection also carries files of a few document and picture kinds, checked on both sides, kept with the person's attachments and never run.
- Keep secrets in a password manager and give bots references, not values.
