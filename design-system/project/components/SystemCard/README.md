A card from Pobots itself, not from a bot: something about the app the person should see, such as a nightly backup that failed. It stands on the "Needs you" rail with the bots' cards.

You provide the topic, a title and a sentence or two.

- **The head** is Pobots' own mark (`pb-pobots-mark`), then **Pobots** and "tells you". The mark is the first letter of the name, set like the wordmark (600), in a soft round disc on `fill`. Never a face and never the pebble shape: Pobots is not a bot. It stands in for a logo until there is one.
- **The title** says the news in a few words: "Last night's backup failed", "Last night's upload was not confirmed", "No backup for two days". The text says why in one plain sentence.
- **Two buttons**: the way to the page it is about ("Open backup settings") and a quiet "Dismiss". No accent: nothing here is the one thing to press.
- **At most one per topic.** A newer card on the same topic takes the old one's place, in the same slot: the slot does not leave and nothing arrives; the new words fade in where the old ones were. The engine sends the new card first and withdraws the old one after it.
- **It goes by itself** when the matter is settled (after the next saved backup), leaving quietly like an expired card. "Dismiss" puts it away earlier.
- It counts in "Needs you 2" like any card, but it never makes a bot "waiting".

## After an update (topic "update", engine 0.45.0)

On a public install, once after Pobots updated itself, the new engine puts up "Pobots is updated to 0.45.0". Under the title the bullets of what is new since the version before, from the repository's `CHANGELOG.md` (see ReleaseNotes): the first three, then a quiet "Show all" that opens the rest in place below them, grouped by version when there were several. One button: a quiet "Dismiss". It stays, also across a reload and a restart, until it is dismissed (on one device, gone on all), and the engine puts it up only once. With no notes for the version, the title alone and "It was 0.44.0 before.".
