import { useEffect, useState, type ReactNode } from "react";
import { downloadFileName } from "../../shared/downloads";
import { botDownloadUrl } from "../state/actions";

export function DownloadButton({ href, name, children = "Download" }: { href: string; name: string; children?: ReactNode }) {
  return <a className="pb-btn pb-btn-sm pb-btn-quiet" href={href} download={name} aria-label={`Download ${name}`}>{children}</a>;
}

/** A pasted local path never becomes a browser navigation. Check it before making it clickable. */
export function MarkdownDownload({ botId, path, children }: { botId?: string; path: string | null; children?: ReactNode }) {
  const href = botId && path ? botDownloadUrl(botId, path) : undefined;
  // The in-window stand-in supplies the bytes directly, only when its file exists.
  const embedded = href?.startsWith("data:") ?? false;
  const [result, setResult] = useState<{ href: string; ok: boolean }>();
  useEffect(() => {
    if (!href || embedded) return;
    const abort = new AbortController();
    void fetch(href, { method: "HEAD", signal: abort.signal }).then(
      (res) => !abort.signal.aborted && setResult({ href, ok: res.ok && res.headers.get("Content-Type") === "application/octet-stream" }),
      () => !abort.signal.aborted && setResult({ href, ok: false }),
    );
    return () => abort.abort();
  }, [href, embedded]);
  const name = path ? downloadFileName(path) : "";
  const words = children || name;
  const missing = !href || (result?.href === href && !result?.ok);
  const meta = missing ? "File unavailable" : name !== children ? name : "";
  return (
    <span className="pb-md-file">
      {href && (embedded || (result?.href === href && result.ok))
        ? <a href={href} download={name} title={`Download ${name}`}>{words}</a>
        : <span>{words}</span>}
      {meta && <small> · {meta}</small>}
    </span>
  );
}
