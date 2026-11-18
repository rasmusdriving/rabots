// The calendar tools as a bot sees them (engine 0.25.0, docs/build/step-calendar.md): names,
// descriptions and shapes. The work is in core/calendar.ts. Kept apart as T3 Code keeps a tool kit's
// tools apart from their handlers (apps/server/src/mcp/toolkits/pullRequests/tools.ts, handlers.ts).
// A bot has these only while its Calendar switch is on and the flow is set up.
import { z } from "zod";
import type { BotTool, ToolResult } from "./claude/session.js";
import type { ToolWords } from "./claude/labels.js";

export const CALENDAR_TOOL_NAMES = {
  list: "calendar_list",
  freeTimes: "calendar_free_times",
  create: "calendar_create",
  move: "calendar_move",
  cancel: "calendar_cancel",
  respond: "calendar_respond",
} as const;

export type CalendarListArgs = { from: string; to?: string };
export type CalendarFreeArgs = { people?: string[]; minutes: number; from?: string; to?: string; count?: number };
export type CalendarAttendeeArg = { address: string; name?: string; optional?: boolean };
export type CalendarCreateArgs = { subject: string; start: string; end?: string; minutes?: number; attendees?: CalendarAttendeeArg[]; text?: string; location?: string };
export type CalendarMoveArgs = { id: string; start: string; end?: string; minutes?: number };
export type CalendarCancelArgs = { id: string; message?: string };
export type CalendarRespondArgs = { id: string; response: "accept" | "tentative" | "decline"; message?: string };

export interface CalendarHost {
  list(args: CalendarListArgs): Promise<ToolResult>;
  freeTimes(args: CalendarFreeArgs): Promise<ToolResult>;
  create(args: CalendarCreateArgs, signal?: AbortSignal): Promise<ToolResult>;
  move(args: CalendarMoveArgs, signal?: AbortSignal): Promise<ToolResult>;
  cancel(args: CalendarCancelArgs, signal?: AbortSignal): Promise<ToolResult>;
  respond(args: CalendarRespondArgs, signal?: AbortSignal): Promise<ToolResult>;
}

const when = (what: string) =>
  z.string().min(1).max(40).describe(`${what}: a date and time like 2026-11-18T10:00, in the person's own time zone unless it carries an offset.`);
const eventId = z.string().min(1).max(1000).describe("The meeting's id, from calendar_list.");
const minutes = z.number().int().min(5).max(1440);

export function calendarToolList(h: CalendarHost, tz: string): BotTool[] {
  return [
    {
      name: CALENDAR_TOOL_NAMES.list,
      description: `See what is in the person's Outlook calendar between two times (at most 31 days): each meeting's time, subject, id, organizer, the others with their answers, whether it is a Teams meeting and the person's own answer. Times are in ${tz}.`,
      shape: {
        from: z.string().min(1).max(40).describe("From: a day like 2026-11-18 (its start), or a date and time."),
        to: z.string().max(40).optional().describe("To: a day (up to its start) or a date and time. Leave out for the end of the from day."),
      },
      handler: (args) => h.list(args as CalendarListArgs),
    },
    {
      name: CALENDAR_TOOL_NAMES.freeTimes,
      description:
        "Find times when the person and the given people inside the company are all free, within working hours (weekdays 08:00 to 17:00), for a meeting of a given length, in a span of at most 14 days. People outside the company cannot be looked up: use the time agreed with them.",
      shape: {
        people: z.array(z.string().max(320)).max(20).optional().describe("Email addresses of people inside the company. Leave out for the person alone."),
        minutes: minutes.describe("How long the meeting is, in minutes."),
        from: z.string().max(40).optional().describe("Look from this day or time. Leave out for now."),
        to: z.string().max(40).optional().describe("Look until this day or time. Leave out for a week after from."),
        count: z.number().int().min(1).max(20).optional().describe("How many free ranges to give, at most 20. Defaults to 8."),
      },
      handler: (args) => h.freeTimes(args as CalendarFreeArgs),
    },
    {
      name: CALENDAR_TOOL_NAMES.create,
      description:
        "Make a meeting in the person's calendar, always a Teams meeting; Outlook sends the invitations. People inside the company are checked to be free first: when someone is busy nothing is made and you get free times to pick from. People outside the company are not checked. With anyone besides the person it goes on the person's card first and is made only when they approve; a block with nobody else is made at once.",
      shape: {
        subject: z.string().min(1).max(255).describe("The meeting's title."),
        start: when("Start"),
        end: when("End").optional(),
        minutes: minutes.optional().describe("How long, in minutes, when end is left out. Defaults to 30."),
        attendees: z
          .array(
            z.object({
              address: z.string().min(3).max(320).describe("Email address."),
              name: z.string().max(200).optional(),
              optional: z.boolean().optional().describe("true for an optional attendee."),
            }),
          )
          .max(50)
          .optional()
          .describe("Everyone besides the person. Leave out for a block in their own calendar."),
        text: z.string().max(10_000).optional().describe("The invitation's text: what the meeting is about."),
        location: z.string().max(200).optional().describe("A room or place, besides the Teams link."),
      },
      handler: (args, signal) => h.create(args as CalendarCreateArgs, signal),
    },
    {
      name: CALENDAR_TOOL_NAMES.move,
      description:
        "Move a meeting the person organizes to a new time; everything else stays and Outlook tells the others. The same check as calendar_create for people inside the company. With anyone besides the person it goes on the person's card first. A meeting someone else organizes cannot be moved: answer it with calendar_respond instead.",
      shape: { id: eventId, start: when("New start"), end: when("New end").optional(), minutes: minutes.optional().describe("New length in minutes. Leave out to keep the length.") },
      handler: (args, signal) => h.move(args as CalendarMoveArgs, signal),
    },
    {
      name: CALENDAR_TOOL_NAMES.cancel,
      description:
        "Cancel a meeting the person organizes; Outlook tells the others, with your message. With anyone besides the person it goes on the person's card first. A meeting someone else organizes cannot be cancelled: decline it with calendar_respond instead.",
      shape: { id: eventId, message: z.string().max(2000).optional().describe("A short message to the others.") },
      handler: (args, signal) => h.cancel(args as CalendarCancelArgs, signal),
    },
    {
      name: CALENDAR_TOOL_NAMES.respond,
      description: "Answer an invitation in the person's calendar: accept, tentative or decline, with an optional message to the organizer. Always goes on the person's card first.",
      shape: { id: eventId, response: z.enum(["accept", "tentative", "decline"]), message: z.string().max(2000).optional().describe("A short message to the organizer.") },
      handler: (args, signal) => h.respond(args as CalendarRespondArgs, signal),
    },
  ];
}

/** Plain words for a calendar tool call, or undefined when the name is not one. */
export function calendarToolWords(tool: string, input: Record<string, unknown>): ToolWords | undefined {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const subject = str(input.subject);
  switch (tool) {
    case CALENDAR_TOOL_NAMES.list:
      return { done: "Looked at your calendar", running: "Looking at your calendar", failed: "Could not look at your calendar" };
    case CALENDAR_TOOL_NAMES.freeTimes:
      return { done: "Looked for free times", running: "Looking for free times", failed: "Could not look for free times" };
    case CALENDAR_TOOL_NAMES.create:
      return subject
        ? { done: `Booked ${subject}`, running: `Booking ${subject}`, failed: `Could not book ${subject}` }
        : { done: "Booked a meeting", running: "Booking a meeting", failed: "Could not book a meeting" };
    case CALENDAR_TOOL_NAMES.move:
      return { done: "Moved a meeting", running: "Moving a meeting", failed: "Could not move a meeting" };
    case CALENDAR_TOOL_NAMES.cancel:
      return { done: "Cancelled a meeting", running: "Cancelling a meeting", failed: "Could not cancel a meeting" };
    case CALENDAR_TOOL_NAMES.respond:
      return { done: "Answered an invitation", running: "Answering an invitation", failed: "Could not answer an invitation" };
  }
  return undefined;
}
