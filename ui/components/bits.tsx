// Small pieces used everywhere: a bot's face, the status mark and word, and the few icons.
import type { BotLook, BotState } from "../../shared/protocol";
import { STATE_WORD } from "../lib/words";

type FaceSize = "sm" | "md" | "lg" | "xl";

/** A bot's face. Leave `state` out for a plain open-eyed face, as beside a message. */
export function Face({ look, state, size = "md" }: { look: BotLook; state?: BotState; size?: FaceSize }) {
  const cls = size === "md" ? "pb-avatar" : `pb-avatar pb-avatar-${size}`;
  return (
    <span className={cls} data-eyes={look.eyes} data-gap={look.gap === "mid" ? undefined : look.gap} data-color={look.color && look.color !== "grey" ? look.color : undefined} data-state={state} aria-hidden="true">
      <span className="pb-eyes">
        <i />
        <i />
      </span>
    </span>
  );
}

/** The status mark. "check" is the quiet check for a line of finished work. */
export function Mark({ state, title }: { state: BotState | "check"; title?: string }) {
  if (state === "thinking")
    return (
      <span className="pb-mark pb-mark-thinking" title={title} aria-hidden={title ? undefined : true} role={title ? "img" : undefined} aria-label={title}>
        <i />
        <i />
        <i />
      </span>
    );
  return <span className={`pb-mark pb-mark-${state}`} title={title} aria-hidden={title ? undefined : true} role={title ? "img" : undefined} aria-label={title} />;
}

/** A bot's state as its mark and word. `word` replaces the state's own word, keeping its mark and tone. */
export function Status({ state, word }: { state: BotState; word?: string }) {
  const tone = state === "waiting" ? " pb-status-waiting" : state === "blocked" ? " pb-status-blocked" : state === "done" ? " pb-status-done" : "";
  return (
    <span className={`pb-status${tone}`}>
      <Mark state={state} />
      {word ?? STATE_WORD[state]}
    </span>
  );
}

const svg = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export const PlusIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M8 3v10M3 8h10" />
  </svg>
);

export const SendIcon = () => (
  <svg {...svg} strokeWidth={1.75}>
    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
  </svg>
);

/** The send button while a message is to wait in line (steering's other choice): lines, and an arrow to the end. */
export const QueueIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M3 4.5h10M3 8h10M3 11.5h5M11.5 9.25v4.25M9.75 11.75l1.75 1.75 1.75-1.75" />
  </svg>
);

export const StopIcon = () => (
  <svg {...svg} fill="currentColor" stroke="none">
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" />
  </svg>
);

export const CheckIcon = ({ className }: { className?: string }) => (
  <svg {...svg} width={14} height={14} strokeWidth={1.75} className={className}>
    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
  </svg>
);

export const CloseIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

export const BackIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </svg>
);

/** A schedule: a small clock, as on a message from a trigger. */
export const ClockIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 5v3l2 1.25" />
  </svg>
);

/** A channel: a small speech mark, as on a message from a channel and in the roster. */
export const SpeechIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M4.5 3.25h7A1.5 1.5 0 0 1 13 4.75v4.5a1.5 1.5 0 0 1-1.5 1.5H7.75L5 12.75v-2A1.5 1.5 0 0 1 3 9.25v-4.5a1.5 1.5 0 0 1 1.5-1.5Z" />
  </svg>
);

/** A small chevron pointing down, beside a choice that opens a list. */
export const ChevronIcon = () => (
  <svg {...svg} width={12} height={12} viewBox="0 0 12 12" strokeWidth={1.5}>
    <path d="M3 4.75 6 7.75l3-3" />
  </svg>
);

/** A helper: work handed down from the bot, an arrow turning in under it. Never a face: a helper is not a bot. */
export const HelperIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M4.5 3v4.5a2.5 2.5 0 0 0 2.5 2.5h5.5M9.75 7.25 12.5 10l-2.75 2.75" />
  </svg>
);

/** A small chevron pointing right: this row opens something in its place. */
export const ForwardIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M6.5 3.5 11 8l-4.5 4.5" />
  </svg>
);

/** A webhook: an arrow coming in. */
export const HookIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M3 8h7.5M7.5 4.75 10.75 8 7.5 11.25M13 3.5v9" />
  </svg>
);

/** An artifact: a page with a folded corner and a few lines on it, as on its row in the chat and in the list. */
export const ArtifactIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M9.25 2.75H5A1.25 1.25 0 0 0 3.75 4v8A1.25 1.25 0 0 0 5 13.25h6A1.25 1.25 0 0 0 12.25 12V5.75L9.25 2.75Z" />
    <path d="M9.25 2.75v3h3M6 8.5h4M6 10.75h2.5" />
  </svg>
);

/** An artifact that lives on Claude: a page with an arrow leaving it. */
export const ArtifactLinkIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M8.5 2.75H5A1.25 1.25 0 0 0 3.75 4v8A1.25 1.25 0 0 0 5 13.25h6A1.25 1.25 0 0 0 12.25 12V8.5" />
    <path d="M10 2.75h3.25V6M13.25 2.75 8.25 7.75" />
  </svg>
);

/** Opens beside: a window with its right part marked, for a row that opens the panel. */
export const BesideIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <rect x="2.75" y="3.25" width="10.5" height="9.5" rx="1.5" />
    <path d="M9.5 3.25v9.5" />
  </svg>
);

/** Opens somewhere else: an arrow up and out of a box. */
export const OutIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M12.25 9v2.75A1.25 1.25 0 0 1 11 13H4.25A1.25 1.25 0 0 1 3 11.75V5A1.25 1.25 0 0 1 4.25 3.75H7" />
    <path d="M9.5 3h3.5v3.5M13 3 7.75 8.25" />
  </svg>
);

/** Load again: an arrow turning round. */
export const ReloadIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M12.75 8a4.75 4.75 0 1 1-1.4-3.36" />
    <path d="M12.75 3v2.5h-2.5" />
  </svg>
);

/** Publish: an arrow going up from a line. */
export const PublishIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M8 10.5V3M4.75 6.25 8 3l3.25 3.25M3.5 13h9" />
  </svg>
);

/** Wider: the panel's edge moves to the left. */
export const WiderIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M7.5 4.5 4 8l3.5 3.5M12 4.5 8.5 8l3.5 3.5" />
  </svg>
);

/** Narrower: the panel's edge moves to the right. */
export const NarrowerIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M8.5 4.5 12 8l-3.5 3.5M4 4.5 7.5 8 4 11.5" />
  </svg>
);

/** Fill the main area: four corners going out. */
export const FillIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M3 6.25V3h3.25M13 6.25V3H9.75M3 9.75V13h3.25M13 9.75V13H9.75" />
  </svg>
);

/** Back beside the chat: four corners coming in. */
export const UnfillIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M6.25 3v3.25H3M9.75 3v3.25H13M6.25 13V9.75H3M9.75 13V9.75H13" />
  </svg>
);

/** The browser: a small drawn window with a line across its top. Never a globe, never a face. */
export const BrowserIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <rect x="2.75" y="3.25" width="10.5" height="9.5" rx="1.5" />
    <path d="M2.75 6.25h10.5" />
  </svg>
);

/** Back in the page's own history: an arrow to the left. */
export const PageBackIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M12.5 8h-9M7 4.5 3.5 8 7 11.5" />
  </svg>
);

/** Forward in the page's own history: an arrow to the right. */
export const PageForwardIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" />
  </svg>
);

/** Another page of the same workspace: two pages, one behind the other. */
export const PagesIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <rect x="2.75" y="5.25" width="8.5" height="7.5" rx="1.25" />
    <path d="M5.25 3.25h6.75a1.25 1.25 0 0 1 1.25 1.25v5.75" />
  </svg>
);

/** Another workspace or your own page: two windows, one behind the other. */
export const SpacesIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <rect x="2.75" y="5.75" width="8.5" height="7" rx="1.25" />
    <path d="M2.75 8.25h8.5M5.25 3.25h6.75a1.25 1.25 0 0 1 1.25 1.25v5.5" />
  </svg>
);

/** A file the person attached: a sheet with lines on it, in a soft square, never on a disc (that is an artifact's). */
export const FileIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M4.25 2.75h5l2.5 2.5v8h-7.5Z" />
    <path d="M6.25 7.25h3.5M6.25 9.25h3.5M6.25 11.25h2" />
  </svg>
);

/** A picture that cannot be drawn here: a frame with a hill and a sun. */
export const PictureIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <rect x="2.75" y="3.25" width="10.5" height="9.5" rx="1.5" />
    <path d="M2.75 11 6 7.75 9.5 11.25M8.5 10.25l1.75-1.75 3 3" />
    <circle cx="10.25" cy="6" r="0.9" />
  </svg>
);

/** Settings for Pobots as a whole: three sliders, each with its knob. Never a cog that turns. */
export const SettingsIcon = () => (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M3 4.5h3.25M9.25 4.5H13M3 8h6.25M12.25 8H13M3 11.5h1.75M7.75 11.5H13" />
    <circle cx="7.75" cy="4.5" r="1.5" />
    <circle cx="10.75" cy="8" r="1.5" />
    <circle cx="6.25" cy="11.5" r="1.5" />
  </svg>
);

/**
 * Pobots' own mark, where a bot's face would be on a card from Pobots itself: the first letter of
 * the name, set like the wordmark, in a soft round disc. Never a face: Pobots is not a bot. Until
 * there is a logo.
 */
export const PobotsMark = ({ size = "sm" }: { size?: "sm" | "lg" }) => (
  <span className={`pb-pobots-mark${size === "lg" ? " pb-pobots-mark-lg" : ""}`} aria-hidden="true">
    P
  </span>
);

// ------------------------------------------------------------ step 7b: the icon row at the foot of the left side

/** Settings: a gear that stands still (Lucide's settings, drawn on the 16 px grid). Never one that turns. */
export const GearIcon = () => (
  <svg {...svg} viewBox="0 0 24 24" width={18} height={18} strokeWidth={1.75}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

/** Usage: three bars of different heights, as T3 Code draws it. */
export const UsageIcon = () => (
  <svg {...svg} width={18} height={18} strokeWidth={1.5}>
    <path d="M4 13V8M8 13V3M12 13v-3.5" />
  </svg>
);

/** An update is ready: an arrow up in a circle. */
export const UpdateIcon = () => (
  <svg {...svg} width={18} height={18} strokeWidth={1.5}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 11V5.25M5.5 7.5 8 5l2.5 2.5" />
  </svg>
);
