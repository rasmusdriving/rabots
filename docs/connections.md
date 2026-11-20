# Connect two Pobots

Two people can connect their separate Pobots so their bots can ask or tell each other things and pass files. A connection belongs to one bot on each side: the main bot unless you choose another (0.44.0). Both installs need Pobots 0.37.0 or later, and 0.44.0 or later for files. You can use separate Tailscale networks. There is no shared account or relay.

1. In both apps, open **Settings → Connections → Connect to another Pobots**. Give the other Pobots a name, such as Sam or Kim, and choose how long the connection lasts under **Ends after**: 24 hours, 30 days or never (the default).
2. Make a pairing code, copy it and send it to the other person. Get their code over a channel you trust. The code identifies their Pobots; check whose code you are pasting.
3. Paste the code they sent into **Their pairing code** and click **Connect**. Either person can go first. Once both have entered the other's code and the engines can reach each other, the row shows **Connected**. Each code is one line and can be used for only one connection, within 24 hours. That limit is only for the code: the connection lasts as chosen under **Ends after**.

Ask the bot the connection belongs to to send a specific message to the connection by name. It can **ask** for a reply or **tell** the other bot something. You will see incoming text as a message from another Pobots. Pause to stop sending and receiving, or remove the connection. If the other Pobots cannot be reached during removal, the other person may need to remove their copy too.

## Which bot a connection belongs to

Each connection belongs to one of your bots, shown on its row as "Belongs to Skifte". Choose it under **Belongs to** when you make the pairing code or later with **Edit**; the main bot is the default, and every connection made before 0.44.0 is the main bot's. Your main bot can change it too (`set_connection` with `owner`), and you see a quiet line in its chat.

- Messages and files on it go to that bot's chat and its folder's `.attachments`, framed as outside information as always, and the message says whose connection it came on. Only that bot can send on it (`message_pobots`); a bot without a connection of its own has no such tool, and the main bot sends only on its own connections.
- Your main bot's `list_connections` shows that a connection exists, its state, its times and whose it is, never what was said on it. This is a rule for Pobots' own tools: a main bot with full access could still look into another bot's folder with its own file tools.
- Lines about sending (a message dropped, refused or not taken) go to the bot it belongs to; lines about managing it (made, paused, renamed, a new owner, removed) go to the main bot. When a connection ends, both are told.
- When you change whose it is, what is already in a chat stays there, and an ask the old bot was handed is still answered by it. Its own asks waiting for an answer stop waiting; a later answer goes to the new bot.
- While the bot is on vacation its messages wait, unseen, and its row says so; they arrive when it is back. If the bot is retired, the connection goes back to the main bot with a quiet line. If its folder is gone without a retire, the main bot gets the messages and is told once.
- Nothing changes for the other side: they see the same connection.

## How long a connection lasts

Each row says what is left: "Ends in 23 hours", "Ends in 29 days" or "Lasts until removed". The time counts from when both sides are connected. Change it with **Edit**; a new choice counts from then. Each side ends its own copy when its time is up. It then tells the other side, which ends its copy at once or at its next contact, so the shorter choice wins. An ended connection shows **Ended** for 7 days with only **Remove**, and then goes by itself. To connect again, make new pairing codes. Your main bot can set and change it too, and you see a quiet line in its chat.

## Files

The bot a connection belongs to can send up to 5 files from its own folder with a message: `.md`, `.markdown`, `.txt`, `.csv`, `.pdf`, `.docx`, `.xlsx`, `.pptx`, `.png`, `.jpg` and `.jpeg`, at most 10 MB a file and 20 MB a message. The contents must match the name. Files in hidden folders (other than received attachments), links that lead out of the folder, and anything that looks like it holds a secret, by its name or (for text) its contents, are refused before anything is sent. A file is copied when the bot sends it, so later changes do not change what goes.

The receiving Pobots checks the files again by itself and takes at most 60 MB of files an hour on one connection. Files it does not take are refused with a reason, and the sending bot is told. Received files go into the folder of the bot the connection belongs to, under `.attachments`, like your own attachments. They are kept 14 days, shown under the message, and given to the bot as outside data. They are never opened with another program or run. A reply to an ask is text; to send files back, the other bot sends a tell with files. Both Pobots need 0.44.0 or later. If the other side has not updated, your bot is told so and nothing is sent; it can send the text alone.

## Give one Pobots a public address

Only one of the two needs a public address. The other Pobots calls that address to send and collect messages. If you already publish Pobots webhooks through Tailscale Funnel and have set `publicBase`, you can use the same address.

To set it up on the Pobots that will be reachable:

1. Follow the [Tailscale Funnel setup](https://tailscale.com/kb/1223/funnel) for that machine. Use a supported Funnel port, such as 10000, and check which ports are in use first.
2. Run Pobots with a fixed local port. For the default port `47600`, publish **only** its `/hook` path:

   ```sh
   tailscale funnel --bg --https=10000 --set-path=/hook http://127.0.0.1:47600/hook
   tailscale funnel status
   ```

3. Set `publicBase` in Pobots' `config.json` to the HTTPS origin Funnel shows, such as `https://mac.example.net:10000`. Leave off `/hook`. Restart that Pobots and make a new code. See [Configuration](configuration.md).

Do not publish the whole engine, the app page, or an app port through Funnel. To change a connection's public address, remove it and pair again with fresh codes. If neither Pobots can have a public address, they cannot pair using this feature.

## What a connection allows

Pairing codes carry public keys, your main bot's display name and an address if set. They do not grant a login. The engines sign and encrypt messages as well as using HTTPS. Your private keys stay in your Pobots data folder.

The bot the connection belongs to reads an incoming message in its normal chat, with its memory and tools. It may act within the access level you gave it. Pobots tells it to treat the message as outside information, never as your instructions or approval, and to ask you before doing anything irreversible or visible to other people on the other bot's word alone. Its reply to an ask is sent back. Tell your bot what it may share. A model can be talked into making mistakes, so pair only with people you trust. **Pause** stops the exchange of new messages at once.

A connection can receive at most 6 messages a minute and 30 an hour; a message with files counts as one. A message may contain up to 20,000 characters. When the other Pobots cannot be reached, up to 50 messages can wait for up to 24 hours each. If an ask is not answered while your bot waits, a later reply arrives as its own outside message.
