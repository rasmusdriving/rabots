// App window entry point. Picks the engine, sets the theme and draws the app.
//   Inside the desktop shell: the engine the shell hands over, with its token.
//   In a plain browser: the engine that served the page, on the same origin, without a token.
//   Both upload pictures and files over HTTP: the page to its own origin, the desktop window (a file
//   page) to 127.0.0.1 with its token, which the engine answers with CORS for a file page alone.
//   ?mock=1: the built-in sample engine, for building and reviewing screens.
import { createRoot } from "react-dom/client";
import "./app.css";
import "./phone-shell.css";
import "./phone-chat.css";
import "./sees.css";
import "./activity.css";
import { App } from "./components/App";
import { MockEngine, parseScene } from "./engine/mock";
import { askWhoAmI, sameOriginEndpoint, WsEngineClient } from "./engine/ws-client";
import { applyTheme, params } from "./lib/env";
import { followViewport } from "./lib/phone";
import { startPush } from "./lib/push";
import { connect } from "./state/actions";
import { store } from "./state/store";

applyTheme();
// On a phone the shell follows the visible height above the on-screen keyboard; on the laptop this sets nothing.
followViewport();

const bridge = window.pobots;
const useMock = params.get("mock") === "1";
const scene = parseScene(params.get("scene"));

connect(
  useMock
    ? new MockEngine(scene, params)
    : bridge
      ? new WsEngineClient(() => bridge.engine(), undefined, true)
      : new WsEngineClient(async () => sameOriginEndpoint(), askWhoAmI, true),
);

// Notifications when the page is not open (ui/lib/push.ts): what this browser can do, presence, a
// click on a notification, tidying the tray. Never asks for permission by itself.
startPush();

// With the mock, scripted checks may read the window's state, to see that no address or secret is kept in it.
if (useMock) (window as unknown as { pobotsState?: () => unknown }).pobotsState = () => store.get();

// A page in a browser asks the engine how it got in: "local" means it runs on the engine's own
// machine, so that machine reads "this one" under Machines; from any other device it reads "connected".
if (!useMock && !bridge && !params.has("device")) {
  void askWhoAmI().then((who) => {
    if (who?.allowed) store.setEngineHere(who.via === "local");
  });
}

// Closing the window with unsaved text in an editor asks first.
window.addEventListener("beforeunload", (e) => {
  if (store.get().unsaved) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(<App pickerOpenAtStart={useMock && scene === "picker"} />);
