# Ahead: your time

Part B of Ahead. Bots the person allows ask for a piece of the person's time to look at something; Pobots places it in the first free slot inside the working hours, around meetings and other slots, with five minutes of air. The main bot manages the time and may set any slot itself.

A "your time" row is an Ahead row: the time and its end on one line (09:00-09:30), the bot's face, what to look at, and one quiet line with an amber "Your time" tag (it waits on the person), the length and the bot. "Late" when no slot was free before its latest day. While the slot runs, the end reads "Now" and the row rests on a soft fill. No card, no sound, nothing else moves.

Tapping opens its own sheet: Ask about this (the bot's chat), Open the to-do when it has one, Done, Drop, Move (Later today, Tomorrow, Next free slot, Not this week) and Pick a time. The bot is told at its next turn.

The week note is the main bot's one note, replaced and never stacked. In the row above the days it is one line; in Overview it stands in full on a soft fill, with who it is from.

In the Week grid a slot is a block as tall as its minutes on the soft amber, and it can be dragged to another day and time: see Ahead: the Week grid.

Settings, Ahead, Your time: working hours as typed times, working days as the day toggles, and the most minutes a day.

## To-do blocks (engine 0.41.0)

With "Put to-dos in my calendar" on, every new to-do from a bot gets a block of the person's time. The block is a "your time" row and block like any other, with the amber tag reading "To-do" instead of "Your time", as tall as its minutes in the Week grid and the phone's Day. The dated to-do row is left out while its block is open: one thing, never two. Its event in Outlook is never shown as a grey meeting beside it.

Its sheet puts "Open the to-do" first. Done marks the to-do done. Drop reads "Remove the block": the to-do stays on the list. Open again shows only while its to-do is open. When the block is not in the calendar (a write failed, or the calendar did not answer in time) one quiet line under the why says so; nothing shows when all is well.

Settings, Ahead, "To-dos in your calendar": the switch, shown only while the calendar is connected (else one line that says where to connect it), and "How to schedule me", a text box with its count, "Use the default" and Save, as About you is drawn.
