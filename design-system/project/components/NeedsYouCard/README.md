A needs-you card puts one decision in front of the person, with the choices ready to press.

You provide the bot, a title that names the decision, one line of context, and two or three choices. "Later" is always available and moves the card out of today.

- One decision per card. If a bot has three questions, it makes three cards or asks in chat.
- The title is the question in a few words. The context line is one sentence. More detail opens in the bot's chat.
- Choices are equal, so none is primary. Use a primary button only when the bot recommends one, and say why in the context line.
- A card that has been answered settles and leaves over `dur-slow`. The rail closes the gap without jumping.
- When the rail is empty it reads "Nothing needs you" and shows nothing else.
- An open card survives a restart of Pobots (engine 0.29.0): it comes back in the same place, with the same words and look, and nothing in the rail moves. Answered then, the answer reaches the bot as a new message marked "From your card" (see Message).
- Nothing in a card reaches past its edge (17 Nov 2026): a long word or address in the title, the context line, the well or a choice wraps where it must, and a choice's button grows with its label. A typed answer's field shrinks with the card.
- A bot's question card has, at its foot under the choices, the box to ask about it before answering (protocol 23, see CardQuestions). The card stays open; when the bot asks again, its new words fade in where the old ones were.
