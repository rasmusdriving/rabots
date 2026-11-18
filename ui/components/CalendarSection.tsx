// The settings window's Calendar section (16 Nov 2026, protocol 20): the address of the person's
// calendar flow in Power Automate, written but never shown again (as a channel's address for answers
// is), whose mailbox it works for, "Check the connection", and the email domains of people inside the
// company, whose free times are checked before a meeting is booked. The engine's side is
// engine/core/calendar-settings.ts; the flow is docs/build/step-calendar-flow.md.
import { useState } from "react";
import type { CalendarState } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import { useNow, useSaver } from "../lib/hooks";
import { setCalendar, testCalendar } from "../state/actions";
import { useAppState } from "../state/store";
import { Mark } from "./bits";
import { Confirm } from "./Dialog";
import { SectionHead } from "./SettingsView";
import { checkedWords, ProblemLine } from "./SettingsWindow";

const isFlowUrl = (s: string) => /^(https:\/\/[^\s/]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)(\/\S*)?$/.test(s);

export function CalendarSection() {
  const calendar = useAppState((s) => s.calendar);
  if (!calendar) return <p className="pb-section-text">Pobots has not said how the calendar is yet.</p>;
  return (
    <>
      <Connection calendar={calendar} />
      <Domains calendar={calendar} />
    </>
  );
}

function stateWords(c: CalendarState): { mark: "check" | "idle" | "blocked"; text: string } {
  if (!c.connected) return { mark: "idle", text: "Not set up yet." };
  if (c.problem) return { mark: "blocked", text: c.problem };
  if (c.mailbox) return { mark: "check", text: `Connected to ${c.mailbox.name ? `${c.mailbox.name} (${c.mailbox.address})` : c.mailbox.address}.` };
  return { mark: "idle", text: "The address is set. Check the connection to see whose calendar it is." };
}

function Connection({ calendar }: { calendar: CalendarState }) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState("");
  const [state, save] = useSaver();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string>();
  const now = useNow(30_000);
  const field = "set-calendar-address";
  const words = stateWords(calendar);

  const set = async () => {
    const url = draft.trim();
    if (!url) return;
    if (!isFlowUrl(url)) return setProblem("Use an address that starts with https://.");
    setProblem("");
    setCheckError("");
    // Cleared as it is sent: the engine's change can reach the window before the save resolves, and
    // the address must never stand in the field beside "Connected". It comes back only if saving fails.
    setDraft("");
    if (!(await save(() => setCalendar({ address: url })))) setDraft(url);
  };
  const check = () => {
    if (checking) return;
    setChecking(true);
    setCheckError("");
    testCalendar()
      .catch((e: unknown) => setCheckError(messageOf(e)))
      .finally(() => setChecking(false));
  };
  const remove = async () => {
    setRemoveError(undefined);
    try {
      await setCalendar({ address: "" });
      setRemoving(false);
    } catch (e) {
      setRemoveError(messageOf(e));
    }
  };

  return (
    <section className="pb-section pb-calendar" aria-labelledby="set-calendar">
      <SectionHead id="set-calendar" title="Calendar" state={state} />
      <p className="pb-section-text">
        Bots with the calendar tools use your Outlook calendar through a flow in your Power Automate. The main bot has them; switch them on for other bots in their Settings. A meeting with other people always waits for your approval first.
      </p>
      <p className="pb-reply-state" data-set={words.mark === "check" || undefined} data-calendar-state={words.mark}>
        <Mark state={words.mark} />
        <span>{words.text}</span>
      </p>
      {calendar.connected && (
        <div className="pb-set7-checked">
          <span className="pb-set7-checked-text" role="status">
            {checking ? "Checking now." : checkedWords(calendar.checkedAt, now)}
          </span>
          <button type="button" className="pb-btn pb-btn-sm pb-btn-quiet" aria-disabled={checking || undefined} onClick={check}>
            Check the connection
          </button>
        </div>
      )}
      {calendar.connected && <ProblemLine text={checkError} />}
      <form
        className="pb-field pb-field-wide"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void set();
        }}
      >
        <label className="pb-label" htmlFor={field}>
          {calendar.connected ? "Replace the flow's address with" : "The flow's address"}
        </label>
        <div className="pb-add-row">
          <input
            id={field}
            className="pb-input pb-add-input pb-secret-input"
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            data-1p-ignore=""
            data-lpignore="true"
            spellCheck={false}
            placeholder="https://"
            value={draft}
            aria-describedby={`${field}-hint`}
            onChange={(e) => {
              setDraft(e.target.value);
              setProblem("");
            }}
          />
          <button className="pb-btn pb-btn-sm" type="submit" disabled={!draft.trim() || state.phase === "saving"}>
            {calendar.connected ? "Replace" : "Save"}
          </button>
          {calendar.connected && (
            <button className="pb-btn pb-btn-sm pb-btn-danger" type="button" onClick={() => setRemoving(true)}>
              Remove
            </button>
          )}
        </div>
        <ProblemLine text={problem || (state.phase === "error" ? state.message : "")} />
        <span className="pb-hint" id={`${field}-hint`}>
          {calendar.connected ? "The address is set. It is not shown again. " : ""}
          The flow&apos;s trigger, When an HTTP request is received, gives you this address. Pobots checks it at once.
        </span>
      </form>
      {removing && (
        <Confirm
          title="Remove the calendar's address?"
          text="Bots lose the calendar tools until an address is set again. Nothing in your calendar changes."
          yes="Remove address"
          no="Keep it"
          tone="danger"
          error={removeError}
          onYes={() => void remove()}
          onNo={() => setRemoving(false)}
        />
      )}
    </section>
  );
}

function Domains({ calendar }: { calendar: CalendarState }) {
  const [draft, setDraft] = useState<string>();
  const [state, save] = useSaver();
  const field = "set-calendar-domains";
  const shown = draft ?? calendar.internalDomains.join(", ");
  const changed = draft !== undefined && draft.trim() !== calendar.internalDomains.join(", ");
  const submit = async () => {
    const list = (draft ?? "").split(/[\s,;]+/).filter(Boolean);
    if (await save(() => setCalendar({ internalDomains: list }))) setDraft(undefined);
  };
  const from = calendar.domainsSet ? "Set by you." : calendar.internalDomains.length ? "From your mailbox's address." : "None yet: it comes from your mailbox once the connection is checked.";
  return (
    <section className="pb-section" aria-labelledby="set-calendar-inside">
      <SectionHead id="set-calendar-inside" title="Inside the company" state={state} />
      <p className="pb-section-text">
        People whose email ends in one of these domains are inside the company: a meeting with them is booked only when they are free. For people outside, the time you agreed on is used.
      </p>
      <form
        className="pb-field pb-field-wide"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="pb-label" htmlFor={field}>
          Email domains
        </label>
        <div className="pb-add-row">
          <input
            id={field}
            className="pb-input pb-add-input"
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="example.com"
            value={shown}
            aria-describedby={`${field}-hint`}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button className="pb-btn pb-btn-sm" type="submit" disabled={!changed || state.phase === "saving"}>
            Save
          </button>
          {calendar.domainsSet && (
            <button
              className="pb-btn pb-btn-sm pb-btn-quiet"
              type="button"
              disabled={state.phase === "saving"}
              onClick={() => void save(() => setCalendar({ internalDomains: [] })).then((ok) => ok && setDraft(undefined))}
            >
              Use the mailbox&apos;s
            </button>
          )}
        </div>
        <ProblemLine text={state.phase === "error" ? state.message : ""} />
        <span className="pb-hint" id={`${field}-hint`}>
          {from} Separate several with commas.
        </span>
      </form>
    </section>
  );
}
