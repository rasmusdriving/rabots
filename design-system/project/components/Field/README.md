Fields are the controls on a bot's settings card: a text input, a switch, and a segmented choice.

- **Text input** (`pb-field` with `pb-label`, `pb-input`, `pb-hint`): names, schedules, paths.
- **Switch** (`pb-toggle` with `pb-switch`): one thing that is on or off, taking effect at once.
- **Quiet switch** (`pb-switch-quiet` inside a button with `role="switch"` and `aria-checked`): a setting that stands beside a choice and must be as calm as the choice, such as "Fast" beside the effort (see ModelPicker). 28 by 16 px. Off, a `fill-strong` track with an `ink-muted` knob; on, an `ink-muted` track with a knob of the surface, the knob moved over. Never `accent`: on is told by the knob's place and the track's grey. The button carries the name in the type of the choice beside it (`pb-fast`, 13px weight 500, `ink-muted` off and `ink` on) and may carry a few quiet words after it. Space and Enter switch it; the focus ring is the usual 2px ring. Its size is fixed, so switching moves nothing.
- **Segmented choice** (`pb-seg`): two to four options where exactly one applies, such as the access level.

You provide the label, the value and a hint.

- The hint says what the current choice means in plain words. It changes with the choice.
- Settings save as they change. There is no Save button; a short "Saved" (`pb-saved`, in a `pb-label-row` beside the label) appears beside the field and fades. A text field saves when you leave it or press Enter; Escape puts the old value back.
- A longer text in a form, such as a new bot's job, uses `pb-input pb-textarea`. Mark optional fields with `pb-label-note` ("optional").
- Label switches as a fact: "May message Kaja", not "Enable messaging".
- Access levels are always these four, in this order: "Asks first", "Edits freely", "Decides itself", "Full access".
- Longer text such as a bot's job description is edited in the in-app editor, not in a field.
