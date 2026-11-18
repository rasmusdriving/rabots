// The app check's section "calendar" (docs/build/step-calendar.md, 16 Nov 2026): a real bot on the
// cheapest Claude model uses the calendar tools against the stand-in for the calendar flow
// (scripts/calendar-standin.mjs), never Outlook. The address is set and checked; a bot that is not
// the main bot has no tools until its switch is on; a block with nobody else is made at once as a
// Teams meeting; a meeting with someone inside the company waits on a card and is made when it is
// approved; a meeting with someone who is busy is not made and no card comes. Nothing leaves this
// computer. Run it alone: node scripts/app-check.mjs --only=calendar.
import { makeCalendarStandin } from "../../calendar-standin.mjs";
import { sleep, check, sideChannel, run } from "../lib.mjs";

const RULES = "This is a check inside Pobots only. Use only the Pobots tool named here; use no connectors or MCP servers, change no files outside your own folder.";
const DAY = 24 * 60 * 60_000;

/** A weekday at least `ahead` days from now, as 2026-11-18 (the bot reads it in the person's own time zone). */
function weekday(ahead, from = Date.now()) {
  const d = new Date(from + ahead * DAY);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default async function section() {
  const { endpoint, cheap } = run;
  const s = await sideChannel(endpoint);
  const day1 = weekday(3);
  // The weekday after day1. Counting from today instead gave day1 again on a Wednesday (3, 4 and 5
  // days ahead all land on the same Monday), so Alex was busy on day1 too (release 0.32.0).
  const day2 = weekday(1, Date.parse(`${day1}T12:00:00`));
  // Alex (inside) is busy the whole of day2, in every time zone.
  const d2 = Date.parse(`${day2}T00:00:00Z`);
  const standin = makeCalendarStandin({ busy: { "alex@example.com": [{ start: d2 - DAY / 2, end: d2 + DAY * 1.5 }] } });
  const address = await standin.listen(0);
  try {
    // The connection: set, checked, whose mailbox; the address never comes back.
    const set = (await s.request("calendar.set", { address })).calendar;
    check("calendar: the address is set and checked: the stand-in's mailbox", set.connected && set.mailbox?.address === "robin@example.com" && !set.problem && set.internalDomains.join(",") === "example.com", JSON.stringify(set));
    check("calendar: the address is never sent back", !JSON.stringify(set).includes("standin-secret") && !JSON.stringify(await s.request("calendar.get", {})).includes("standin-secret"));
    const snap0 = await s.request("snapshot");
    check("calendar: the snapshot carries the connection", snap0.calendar?.connected === true && !JSON.stringify(snap0.calendar).includes("standin-secret"), JSON.stringify(snap0.calendar));
    const haiku = snap0.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
    const low = haiku.efforts.includes("low") ? "low" : haiku.defaultEffort;
    const cardsAtStart = new Set(snap0.cards.map((c) => c.id));
    const bot = (await s.request("bot.create", { name: "Planner", purpose: "For the calendar check", job: "Do what you are asked, briefly. Never use a connector or an MCP server.", model: haiku.id, effort: low })).bot;
    check("calendar: a new bot that is not the main bot has the tools off", bot.calendar === false, String(bot.calendar));
    const on = (await s.request("bot.update", { botId: bot.id, patch: { calendar: true } })).bot;
    check("calendar: its switch turns them on", on.calendar === true, String(on.calendar));

    const items = async () => (await s.request("thread.read", { threadId: bot.mainThreadId, limit: 300 })).items;
    const lastSaid = async () => (await items()).filter((i) => i.kind === "bot").at(-1)?.text ?? "";
    const calLines = async () => (await items()).filter((i) => i.kind === "notice" && i.mark === "calendar");
    const creates = () => standin.calls.filter((c) => c.action === "create");
    /** Waits until the bot rests. A meeting card is approved (or denied) as `meeting` says; any other card is denied. */
    const rested = async (meeting = "deny", ms = 180_000) => {
      const end = Date.now() + ms;
      const seen = [];
      await sleep(1500);
      while (Date.now() < end) {
        for (const c of (await s.request("snapshot")).cards) {
          if (cardsAtStart.has(c.id) || seen.some((x) => x.id === c.id)) continue;
          seen.push(c);
          const decision = c.kind === "question" ? { type: "later" } : c.meeting && meeting === "approve" ? { type: "allow-once" } : { type: "deny" };
          await s.request("card.resolve", { cardId: c.id, decision }).catch(() => undefined);
        }
        const b = (await s.request("snapshot")).bots.find((x) => x.id === bot.id);
        if (b && (b.state === "done" || b.state === "idle" || b.state === "blocked") && !b.context?.tidying) return { ok: true, cards: seen };
        await sleep(1000);
      }
      return { ok: false, cards: seen };
    };
    const ask = (text) => s.request("message.send", { botId: bot.id, text: `${RULES} ${text} Then reply with one short sentence.` });

    // 1. A block with nobody else: made at once, a Teams meeting, a line in the chat, no card.
    await ask(`Use your Pobots tool calendar_create exactly once with subject "Focus PEAR", start "${day1}T14:00", end "${day1}T15:00" and no attendees.`);
    const r1 = await rested();
    const c1 = creates().find((c) => c.event?.subject === "Focus PEAR");
    check("calendar: a block with nobody else is made at once, with no card", r1.ok && !!c1 && r1.cards.length === 0, JSON.stringify({ calls: standin.calls.map((c) => c.action), cards: r1.cards.map((c) => c.title) }));
    // Since 0.26.1 in the Mac's own zone (Stockholm here: "W. Europe Standard Time"), wall time as asked, and an HTML body so Outlook formats its Teams block.
    check("calendar: it is a Teams meeting at the asked local time in the Mac's own zone, with no attendees and an HTML body", !!c1 && c1.event.isOnlineMeeting === true && c1.event.onlineMeetingProvider === "teamsForBusiness" && (c1.event.attendees ?? []).length === 0 && c1.event.start?.dateTime?.startsWith(`${day1}T14:00`) && (c1.event.start?.timeZone !== "UTC" || Intl.DateTimeFormat().resolvedOptions().timeZone === "UTC") && c1.event.body?.contentType === "html", JSON.stringify(c1?.event ?? null).slice(0, 300));
    const l1 = (await calLines()).find((l) => l.text.startsWith("Created Focus PEAR ("));
    check("calendar: the chat says Created Focus PEAR (day and time), with the details behind it", !!l1 && /Teams meeting/.test(l1.detail ?? ""), JSON.stringify(l1 ?? (await calLines())).slice(0, 240));

    // 2. A meeting with someone inside who is free: a card first, made when approved.
    const before2 = creates().length;
    await ask(`Use your Pobots tool calendar_create exactly once with subject "Kickoff PLUM", start "${day1}T10:00", end "${day1}T10:30", attendees [{ "address": "alex@example.com" }] and text "A short kickoff.".`);
    const r2 = await rested("approve");
    const card = r2.cards.find((c) => c.meeting);
    check("calendar: a meeting with someone else waits on a card: Book this meeting?, Approve or Deny only", !!card && card.title === "Book this meeting?" && card.caption === "Calendar" && card.noAlways === true, JSON.stringify(card ?? r2.cards).slice(0, 300));
    const alex = card?.meeting?.attendees?.find((a) => a.address === "alex@example.com");
    check("calendar: the card says Alex is inside the company and free then, and that it is a Teams meeting", !!alex && alex.internal === true && alex.free === true && card.meeting.teams === true && card.meeting.subject === "Kickoff PLUM", JSON.stringify(card?.meeting ?? null).slice(0, 300));
    const c2 = creates().slice(before2).find((c) => c.event?.subject === "Kickoff PLUM");
    check("calendar: approved, the flow makes it with Alex as attendee and a Teams link", r2.ok && !!c2 && c2.event.attendees?.[0]?.emailAddress?.address === "alex@example.com" && c2.event.isOnlineMeeting === true && c2.event.body?.contentType === "html" && c2.event.body.content.includes("A short kickoff."), JSON.stringify(c2?.event ?? null).slice(0, 300));
    check("calendar: free times were read before the card", standin.calls.some((c) => c.action === "schedule" && (c.schedules ?? []).includes("alex@example.com")), JSON.stringify(standin.calls.map((c) => c.action)));
    const l2 = (await calLines()).find((l) => l.text.startsWith("Created Kickoff PLUM ("));
    check("calendar: the chat says Created Kickoff PLUM", !!l2, JSON.stringify((await calLines()).map((l) => l.text)));

    // 3. A meeting with someone inside who is busy: not made, no card, the bot is told free times.
    const before3 = creates().length;
    await ask(`Use your Pobots tool calendar_create exactly once with subject "Review FIG", start "${day2}T13:00", end "${day2}T13:30" and attendees [{ "address": "alex@example.com" }]. Do not try again.`);
    const r3 = await rested();
    check("calendar: when Alex is busy nothing is made and no card comes", r3.ok && creates().length === before3 && !r3.cards.some((c) => c.meeting), JSON.stringify({ creates: creates().length - before3, cards: r3.cards.map((c) => c.title) }));
    check("calendar: the bot was told Alex is busy", /(busy|not free|isn't free|is not available|unavailable|free time|other time)/i.test(await lastSaid()), (await lastSaid()).slice(0, 200));

    // The switch off: the tools are gone at the next turn (the session is refreshed).
    const off = (await s.request("bot.update", { botId: bot.id, patch: { calendar: false } })).bot;
    check("calendar: the switch turns them off again", off.calendar === false, String(off.calendar));
  } finally {
    await s.request("calendar.set", { address: "" }).catch(() => undefined);
    await standin.close();
    s.close();
  }
}
