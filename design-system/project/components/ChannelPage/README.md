A channel's page: a Teams channel where people can write to bots through a Power Automate flow. It opens in the reading panel in place of a bot's page, from the channel's row in the roster. One calm column like a trigger's page (`pb-channel-page`, at most 560px wide).

You provide the channel, its messages and the bots.

- **Head**: a drawn speech mark in a disc the size of a face (`pb-who pb-who-mark pb-who-lg`), the name (renamed in place like a bot's name), the quiet line "Teams channel" ("Teams channel · Switched off" when off), and a switch with "On" or "Off" on the right. The switch saves at once.
- **Who may write here**: see WriterList.
- **Tags**: which tag reaches which bot, with the line "A message that tags a bot here is an instruction to that bot. The messages before it are given as background." See RouteList.
- **Background**: how many earlier messages a bot is given, a small number field from 0 to 30. Saved on Enter or on leaving the field; a number out of range goes back to what was saved.
- **Address**: the HookAddress component, asked for with `channel.address`. One line says the Power Automate flow posts to it. Without a public base address from the engine, a hint says Power Automate can only reach it once Pobots has one.
- **Answers**: see SecretField.
- **Posts** (15 Nov 2026): which bots may write new posts here on their own, not only answer. The line "A bot with the switch on may write new posts here on its own, not only answer, through the address for answers. At most 6 an hour each.", then a row per bot as in PeerList (face, name, a switch named "<bot> may post"), off by default. A switch shows its new place at once, saves, and goes back only if the change could not be saved; the section says "Saved" and keeps its height. Without an address for answers a hint says "No address for answers is set yet, so posts cannot go out. Set it under Answers." A post itself shows in the bot's chat: see PostLine.
- **What the flow sends**: see FlowExample.
- **Messages**: see ChannelMessages.
- **Remove this channel** at the bottom, with a confirm ("Remove Ops - Internal?").
- Each section that saves as it changes says "Saved" quietly beside its title for a moment, or what went wrong.
