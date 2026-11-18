The avatar is a bot's face: a soft square, called a pebble, with a pair of eyes that show what the bot is doing.

You provide the bot's look, its state and a size.

- **Look** (kept for life): `data-eyes` is `round`, `tall`, `wide` or `square`, and `data-gap` is `near`, `far` or left out. That gives twelve faces. A new bot gets a look no other bot has.
- **State**: `data-state` is `idle`, `thinking`, `working`, `waiting`, `blocked` or `done`. Leave it out for a plain open-eyed face, as beside a message.
- **Size**: `pb-avatar-sm` 28px, default 36px, `pb-avatar-lg` 48px, `pb-avatar-xl` 96px. The face scales as one piece.

What each state looks like:

| State | Face | Moves |
| --- | --- | --- |
| Idle | asleep, eyes closed | no; it peeks with one eye when its row is hovered |
| Thinking | eyes up, drifting side to side | yes, slowly |
| Working | eyes down on the work | a blink now and then |
| Waiting | looking straight at you, a little wider | a slow blink |
| Blocked | lids half down, tilted with worry | no |
| Done | happy arcs | no |

Rules:

- Faces are eyes only. No mouth, no brows. The eyes are `ink`. The pebble is the bot's colour: `data-color` is `sky`, `teal`, `moss`, `sand`, `copper`, `rose` or `lilac` (it sets `--pebble` to that token), or left out for grey (`pebble`). A new bot gets a colour no other bot has; the person can change it in Settings, in "Add a bot", or through the main bot.
- The face never replaces the status mark and word. It adds feeling; the mark carries the meaning.
- Keep it calm. Eyes move a few hundredths of the face's width, and a blink is over in a fifth of a second. Never bounce, spin, wink at the person or follow the pointer.
- A changed state eases over `dur-quick`. Eyes do not jump.
- The pebble shape and the eyes are for bots only. People, machines and files never get a face.
- Workers do not get their own face. They appear under the bot that started them.
- With reduced motion on, faces hold still in the pose of their state.
