// What had the focus when the panel was opened (a row in the chat, the list's open button, the
// roster's browser line), so closing the panel can give the focus back to it.
let opener: HTMLElement | null = null;

export function rememberOpener(): void {
  const el = document.activeElement;
  opener = el instanceof HTMLElement && el.closest(".pb-artifact, .pb-artifact-item, .pb-browser, .pb-browser-line") ? el : null;
}

/** The element to give the focus back to, once. Null when it is gone. */
export function takeOpener(): HTMLElement | null {
  const el = opener?.isConnected ? opener : null;
  opener = null;
  return el;
}
