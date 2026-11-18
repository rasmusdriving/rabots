The editor is how a bot's job, memory and skills are changed in the app: plain text in a well that fills the space, with a bar above it.

You provide the file's name for people, its path, and the text.

- The text is set in `font-mono`, so markdown lines up as written. No preview pane.
- The bar holds the name, the path in mono, a quiet state word ("Not saved", "Saving", "Saved") and "Save".
- "Save" is the one accent button on the view. It is dimmed until something changed. Cmd+S or Ctrl+S saves too.
- When the file changed underneath, a raised note says so above the well with the waiting mark, and offers "Load the new version" or "Keep editing". Unsaved text is never replaced without asking.
- A file that can be removed has a quiet danger "Remove" in the bar, with a confirm.
- Leaving the editor with unsaved text asks first.
- The well has no border. Keyboard focus draws the 2px focus ring around the whole well.
