What a version of Pobots brings (engine 0.45.0, protocol 36), from the repository's `CHANGELOG.md`. Shown on the Pobots card in Settings, Providers (before an update: "What's new"; after one: "What's new in 0.45.0"), in the update dialog, and on Pobots's own card on the rail after an update (see SystemCard). Shaped like T3 Code's release notes in its update popover.

You provide the notes (`ReleaseNote[]`: version, date, bullets, the true count), how many older versions were left out, and how many bullets show before "Show all".

- **Bullets**, 13 px body ink, with muted markers, newest version first. The engine already cut them: at most 6 versions, 8 bullets a version, 220 characters a bullet. A version with more bullets than shown ends with a muted "And 7 more.".
- **Grouped by version** only when there are several: a small head per version, "0.36.0" in 600 with the date in muted ink beside it. One version has no head: the place says which ("What's new in 0.45.0").
- **Short** (`limit`, three on the cards): the first bullets, then a quiet "Show all" with a chevron. It opens the rest below in place, calmly (rows from 0 to their height in `dur-calm`, `ease-out`), so nothing above moves; the words become "Show less" in the same place. The hidden part is inert while closed. Below everything, muted, "2 older versions not shown." when the engine left versions out.
- **In a box that scrolls** (`data-scroll`, the dialog): every bullet at once on a `fill` well with `radius-md`, at most 192 px tall, scrolled with the keyboard too.
- **A disclosure** (`pb-relnotes-disclosure`): "What's new in 0.45.0" as a quiet toggle that opens the version's bullets in place.
- No notes, no box: a version without a changelog entry shows nothing, never an empty frame.
- Long words wrap; at 360 px nothing scrolls sideways. Reduced motion opens without the move.

Words: "What's new", "What's new in 0.45.0", "Show all", "Show less", "And 7 more.", "2 older versions not shown." The bullets themselves are written for a person, in the app's voice, by whoever makes a release (docs/developing.md).
