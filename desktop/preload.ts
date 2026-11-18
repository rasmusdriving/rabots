// The only bridge between the window and the desktop shell. It hands the UI the engine's
// address and nothing else: the UI then talks to the engine directly over its WebSocket.
import { contextBridge, ipcRenderer } from "electron";
import type { EngineEndpoint } from "../shared/protocol";

export interface PobotsBridge {
  /** Where the engine is. Null when the app was started with --mock. */
  engine(): Promise<EngineEndpoint | null>;
  platform: NodeJS.Platform;
}

const bridge: PobotsBridge = {
  engine: () => ipcRenderer.invoke("pobots:engine") as Promise<EngineEndpoint | null>,
  platform: process.platform,
};

contextBridge.exposeInMainWorld("pobots", bridge);
