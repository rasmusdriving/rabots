The quiet "Channels" group in the roster, above "Machines": the outside places where people write to bots, such as the Teams channel "Ops - Internal".

You provide the channels in the order they were made. Each is one quiet line.

- **Row** (`pb-channel-row`): the channel's name, and on the right a quiet word in `font-mono`, "on" or "off" (`pb-channel-word`), like the words beside the machines. A long name is cut off on one line.
- The row opens the channel's page in the reading panel, in place of a bot's page. The open channel is raised like an open bot row (`surface-raised`, `shadow-raise`), and no bot row is raised while it is open.
- The title has a small add control like the one for bots ("Add a channel"). It opens the new channel sheet (see ChannelSheet).
- With no channels: only the title and the add control. No sentence; the add control is enough.
- Where the roster shows faces only (narrow windows), each channel shows a drawn speech mark in a soft disc (`pb-channel-mark`) and its name and word are read out, not drawn. A switched-off channel's mark has no disc and is fainter.
- Keyboard: each row is a tab stop with the focus ring inside the row.
