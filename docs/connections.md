# Connect two Pobots

Two people can connect their separate Pobots so their main bots can ask or tell each other things. Both installs need Pobots 0.37.0 or later. You can use separate Tailscale networks. There is no shared account or relay.

1. In both apps, open **Settings → Connections → Connect to another Pobots**. Give the other Pobots a name, such as Sam or Kim.
2. Make a pairing code, copy it and send it to the other person. Get their code over a channel you trust. The code identifies their Pobots; check whose code you are pasting.
3. Paste the code they sent into **Their pairing code** and click **Connect**. Either person can go first. Once both have entered the other's code and the engines can reach each other, the row shows **Connected**. Each code is one line, lasts 24 hours and can be used for only one connection.

Ask your main bot to send a specific message to the connection by name. It can **ask** for a reply or **tell** the other main bot something. You will see incoming text as a message from another Pobots. Pause to stop sending and receiving, or remove the connection. If the other Pobots cannot be reached during removal, the other person may need to remove their copy too.

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

Your main bot reads an incoming message in its normal chat, with its memory and tools. It may act within the access level you gave it. Pobots tells it to treat the message as outside information, never as your instructions or approval, and to ask you before doing anything irreversible or visible to other people on the other bot's word alone. Its reply to an ask is sent back. Tell your bot what it may share. A model can be talked into making mistakes, so pair only with people you trust. **Pause** stops the exchange of new messages at once.

A connection can receive at most 6 messages a minute and 30 an hour. A message may contain up to 20,000 characters. When the other Pobots cannot be reached, up to 50 messages can wait for up to 24 hours. If an ask is not answered while your bot waits, a later reply arrives as its own outside message.
