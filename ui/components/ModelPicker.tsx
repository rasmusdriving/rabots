// The model picker: floats above the composer. Models on the left with key hints, in two quiet
// groups "Claude" and "ChatGPT" when both kinds are offered (step 3a), effort for the chosen model on
// the right, machine and access level in the foot. Changes call bot.update. Under the efforts, for a
// model with a fast mode, the switch "Fast" (step 3b): it saves at once and the picker stays open.
// On a phone it is a sheet from the bottom of the screen in one column (phone-chat.css): the models
// one per line, the efforts as a row, no key hints; it does not open the keyboard by itself, and it
// is a history entry, so back closes it.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ACCESS_LEVELS, type AccessLevel, type Bot, type Effort, type ModelInfo } from "../../shared/protocol";
import { EngineError, messageOf } from "../engine/types";
import { updateBot } from "../state/actions";
import { useAppState } from "../state/store";
import { EFFORT_WORD, accessHint, accessWord } from "../lib/words";
import { CHANGE_REFUSED, crossesHarness, groupModels, groupNote, offeredModels } from "../lib/models";
import { FastOption } from "./FastSwitch";
import { isMac } from "../lib/env";
import { usePhone } from "../lib/phone";
import { useBackLayer } from "../lib/phone-back";
import { CheckIcon } from "./bits";
import { keepTabInside } from "./Dialog";

const WIDTH = 580;
const KEYED = 4;

interface Props {
  bot: Bot;
  /** The composer box: the picker lines up with its right edge, just above it. */
  anchor: RefObject<HTMLElement | null>;
  /** The model button: clicks on it are left to it, and focus goes back to it on close. */
  trigger: RefObject<HTMLElement | null>;
  onClose(): void;
}

export function ModelPicker({ bot, anchor, trigger, onClose }: Props) {
  const allModels = useAppState((s) => s.models);
  const status = useAppState((s) => s.status);
  const machines = useAppState((s) => s.machines);
  const [query, setQuery] = useState("");
  const [accessOpen, setAccessOpen] = useState(false);
  const [error, setError] = useState<string>();
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const place = usePlacement(anchor);
  const phone = usePhone();

  // While Codex is not ready no GPT model is offered, except the one the bot is on now.
  const models = offeredModels(allModels, status, bot.model);
  const chosen = allModels.find((m) => m.id === bot.model);
  const shown = models.filter((m) => m.label.toLowerCase().includes(query.trim().toLowerCase()));
  // Headings only when both kinds are offered; a search shows the heading of each group it keeps.
  const grouped = groupModels(models).length > 1;
  const shownGroups = groupModels(shown);
  const machine = machines.find((m) => m.id === bot.machine);
  // The switch's room under the efforts is kept whenever a model offered here has a fast mode, so
  // the column, and with it the picker, keeps its height when the switch comes or goes.
  const fastRoom = models.some((m) => m.fast);

  // On a phone closing goes back through history (the picker is an entry there); back closes it too.
  const refocusOnBack = useRef(true);
  const layer = useBackLayer(() => {
    onClose();
    if (refocusOnBack.current) trigger.current?.focus(phone ? { preventScroll: true } : undefined);
  });
  const close = (refocus = true) => {
    refocusOnBack.current = refocus;
    layer.close();
  };

  // On a phone the search field would open the keyboard over half the sheet: the sheet takes the focus.
  useEffect(() => (phone ? panel.current?.focus({ preventScroll: true }) : search.current?.focus()), []);

  // A click outside closes it. A click on the model button is left to the button, which toggles.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || trigger.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  });

  const apply = (patch: Partial<Pick<Bot, "model" | "effort" | "fast" | "access">>, then?: () => void) => {
    setError(undefined);
    const cross = !!patch.model && crossesHarness(allModels, bot, patch.model);
    updateBot(bot.id, patch).then(then, (e: unknown) => setError(cross && e instanceof EngineError && e.code === "conflict" ? CHANGE_REFUSED : messageOf(e)));
  };

  const pickModel = (m: ModelInfo) => {
    if (m.id === bot.model) return;
    const effort: Effort = m.efforts.includes(bot.effort) ? bot.effort : m.defaultEffort;
    apply({ model: m.id, effort });
  };
  const pickEffort = (effort: Effort) => apply({ effort }, () => close());
  const pickAccess = (access: AccessLevel) => {
    setAccessOpen(false);
    apply({ access });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (accessOpen) setAccessOpen(false);
      else close();
      return;
    }
    // On a phone the picker is a sheet over the whole screen: Tab stays inside it, as in a dialog.
    if (phone && panel.current) keepTabInside(e, panel.current);
    if ((isMac ? e.metaKey : e.ctrlKey) && /^[1-9]$/.test(e.key)) {
      const m = models[Number(e.key) - 1];
      if (m && Number(e.key) <= KEYED) {
        e.preventDefault();
        pickModel(m);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const col = (document.activeElement as HTMLElement | null)?.closest(".pb-picker-col, .app-access-menu");
      if (!col) return;
      const options = [...col.querySelectorAll<HTMLElement>(".pb-option, .pb-search")];
      const at = options.indexOf(document.activeElement as HTMLElement);
      const next = options[Math.max(0, Math.min(options.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) {
        e.preventDefault();
        next.focus();
      }
    }
  };

  const keyHint = (n: number) => (isMac ? `⌘${n}` : `Ctrl ${n}`);

  return createPortal(
    <div
      ref={panel}
      className="pb-pop pb-picker pb-arrive app-picker"
      role="dialog"
      aria-label="Choose model"
      tabIndex={phone ? -1 : undefined}
      style={phone ? undefined : place}
      onKeyDown={onKeyDown}
    >
      <div className="pb-picker-col" role="group" aria-label="Model">
        <input
          ref={search}
          className="pb-search"
          type="text"
          placeholder="Search models"
          aria-label="Search models"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && shown[0]) {
              e.preventDefault();
              pickModel(shown[0]);
            }
          }}
        />
        {shownGroups.map((g) => {
          // The heading of the group the bot is not on says, before the choice, what choosing there means.
          const note = groupNote(g.harness, bot.harness);
          return (
          <Fragment key={g.harness}>
            {grouped && (
              <div className="pb-picker-group" data-harness={g.harness} aria-hidden="true">
                <span className="pb-group-name">{g.label}</span>
                {note && <span className="pb-group-note">{note}</span>}
              </div>
            )}
            {g.models.map((m) => {
              const n = models.indexOf(m) + 1;
              const selected = m.id === bot.model;
              return (
                <button
                  key={m.id}
                  className="pb-option"
                  type="button"
                  aria-selected={selected}
                  aria-pressed={selected}
                  aria-label={grouped ? `${m.label}, ${g.label}${note ? `, ${note}` : ""}` : undefined}
                  onClick={() => pickModel(m)}
                >
                  {m.label}
                  {selected && <CheckIcon />}
                  {n <= KEYED && !phone && <span className="pb-key pb-push">{keyHint(n)}</span>}
                </button>
              );
            })}
          </Fragment>
          );
        })}
        {shown.length === 0 && <div className="app-picker-none">No model matches</div>}
      </div>

      <div className="pb-picker-col pb-picker-side" role="group" aria-label="Effort">
        <div className="pb-picker-title">
          <span>Effort</span>
          <span>{chosen?.label ?? bot.model}</span>
        </div>
        {(chosen?.efforts ?? [bot.effort]).map((effort) => {
          const selected = effort === bot.effort;
          return (
            <button key={effort} className="pb-option" type="button" aria-selected={selected} aria-pressed={selected} onClick={() => pickEffort(effort)}>
              {EFFORT_WORD[effort]}
              {selected ? <CheckIcon className="pb-push" /> : effort === chosen?.defaultEffort && <span className="pb-option-note">Default</span>}
            </button>
          );
        })}
        {fastRoom && (
          <div className="pb-fast-room">
            {chosen?.fast && <FastOption on={bot.fast !== false} hint={chosen.fastHint} onChange={(fast) => apply({ fast })} />}
          </div>
        )}
      </div>

      <div className="pb-pop-foot app-picker-foot">
        <span className="app-picker-fact" title="The machine this bot lives on">
          {machine?.name ?? bot.machine}
        </span>
        {error && (
          <span className="app-picker-error" role="alert">
            {error}
          </span>
        )}
        <div className="app-access">
          <button className="pb-btn pb-btn-sm pb-btn-quiet" type="button" aria-haspopup="menu" aria-expanded={accessOpen} onClick={() => setAccessOpen(!accessOpen)}>
            {accessWord(bot.access)}
          </button>
          {accessOpen && <AccessMenu current={bot.access} onPick={pickAccess} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function AccessMenu({ current, onPick }: { current: AccessLevel; onPick(level: AccessLevel): void }) {
  const [hint, setHint] = useState<AccessLevel>(current);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <div className="pb-pop pb-arrive app-access-menu" role="menu" aria-label="Access">
      {ACCESS_LEVELS.map((a, i) => (
        <button
          key={a.id}
          ref={i === 0 ? first : undefined}
          className="pb-option"
          type="button"
          role="menuitemradio"
          aria-checked={a.id === current}
          aria-selected={a.id === current}
          onMouseEnter={() => setHint(a.id)}
          onFocus={() => setHint(a.id)}
          onClick={() => onPick(a.id)}
        >
          {a.label}
          {a.id === current && <CheckIcon className="pb-push" />}
        </button>
      ))}
      <p className="pb-hint app-access-hint">{accessHint(hint)}</p>
    </div>
  );
}

/** Fixed position just above the anchor, lined up with its right edge, kept inside the window. */
function usePlacement(anchor: RefObject<HTMLElement | null>) {
  const [style, setStyle] = useState<{ left: number; bottom: number; width: number }>({ left: 8, bottom: 8, width: WIDTH });
  useLayoutEffect(() => {
    const measure = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(WIDTH, window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
      setStyle({ left, bottom: window.innerHeight - r.top + 8, width });
    };
    measure();
    // When the picker opens together with the composer, the composer's ref is set a moment later.
    const frame = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
    };
  }, [anchor]);
  return style;
}
