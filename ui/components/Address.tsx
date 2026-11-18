// An address that works like a password: a webhook's or a channel's. Hidden until "Show address",
// which asks the engine for it (trigger.address, channel.address). The engine's public base address
// is put in front when it gives one, otherwise the address the engine is reached on here. The
// address is held only while shown, never in the store. Also the quiet Copy button.
import { useEffect, useRef, useState } from "react";
import { messageOf } from "../engine/types";
import type { HookAddress as Address } from "../state/actions";
import { engineOrigin } from "../lib/env";
import { Confirm } from "./Dialog";

export function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string) => {
    const done = () => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2400);
    };
    const fallback = () => {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      if (ok) done();
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  };
  return [copied, copy];
}

/** "Copy", which says "Copied" for a moment. Its width stays put, so nothing beside it moves. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, copy] = useCopied();
  return (
    <>
      <button className="pb-btn pb-btn-sm pb-copy" type="button" aria-label={label} data-copied={copied || undefined} onClick={() => copy(text)}>
        {copied ? "Copied" : "Copy"}
      </button>
      <span className="app-sr" role="status">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}

/** The full address: the public base when the engine gives one, otherwise where the engine is reached here. */
async function fullAddress(a: Address): Promise<{ url: string; isPublic: boolean }> {
  if (a.publicBase) return { url: `${a.publicBase.replace(/\/+$/, "")}${a.hookPath}`, isPublic: true };
  return { url: `${await engineOrigin()}${a.hookPath}`, isPublic: false };
}

interface HookAddressProps {
  /** One plain sentence above it: who can do what with it. */
  sentence: string;
  /** What the address is, for a screen reader: "Webhook address", "Channel address". */
  label: string;
  load(): Promise<Address>;
  renew(): Promise<Address>;
  /** An example call made from the address, shown under "Try it". */
  example?(url: string): string;
  /** A line under the address (or under the example). */
  hint?: string;
  /** A line shown when the engine has no public base address, so the address only works nearby. */
  privateHint?: string;
}

export function HookAddress({ sentence, label, load, renew, example, hint, privateHint }: HookAddressProps) {
  const [shown, setShown] = useState<{ url: string; isPublic: boolean } | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [renewError, setRenewError] = useState<string>();

  const show = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setShown(await fullAddress(await load()));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const doRenew = async () => {
    setBusy(true);
    setRenewError(undefined);
    try {
      setShown(await fullAddress(await renew()));
      setAsking(false);
    } catch (e) {
      setRenewError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const call = shown && example ? example(shown.url) : "";

  return (
    <div className="pb-hook">
      <p className="pb-section-text">{sentence}</p>
      {!shown ? (
        <div className="pb-card-actions">
          <button className="pb-btn pb-btn-sm" type="button" disabled={busy} onClick={() => void show()}>
            Show address
          </button>
        </div>
      ) : (
        <>
          <div className="pb-address">
            <code className="pb-address-text" aria-label={label}>
              {shown.url}
            </code>
            <CopyButton text={shown.url} label="Copy the address" />
          </div>
          {!shown.isPublic && privateHint && <span className="pb-hint">{privateHint}</span>}
          {call && (
            <>
              <span className="pb-label pb-hook-label">Try it</span>
              <div className="pb-address">
                <code className="pb-address-text" aria-label="Example call">
                  {call}
                </code>
                <CopyButton text={call} label="Copy the example" />
              </div>
            </>
          )}
          {hint && <span className="pb-hint">{hint}</span>}
          <div className="pb-card-actions">
            <button className="pb-btn pb-btn-sm pb-btn-quiet pb-btn-flush" type="button" onClick={() => setShown(null)}>
              Hide address
            </button>
            <button className="pb-btn pb-btn-sm pb-btn-quiet" type="button" onClick={() => setAsking(true)}>
              New address
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="pb-hint app-hint-error" role="alert">
          {error}
        </p>
      )}
      {asking && (
        <Confirm
          title="Make a new address?"
          text="The old address stops working at once. Anything that calls it needs the new one."
          yes="Make a new address"
          no="Keep this one"
          busy={busy}
          error={renewError}
          onYes={() => void doRenew()}
          onNo={() => setAsking(false)}
        />
      )}
    </div>
  );
}
