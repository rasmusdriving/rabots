// A bot's words as Markdown. File paths and website links have different actions.
import { memo, useMemo } from "react";
import Markdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownFilePath } from "../../shared/downloads";
import { MarkdownDownload } from "./FileDownload";

// Keep local paths as data for our own renderer, including file: URLs which Markdown usually strips.
const urlTransform: UrlTransform = (href, key) =>
  (key === "href" || key === "src") && markdownFilePath(href) !== undefined ? href : defaultUrlTransform(href);

export const MarkdownText = memo(function MarkdownText({ text, botId }: { text: string; botId?: string }) {
  const components = useMemo<Components>(() => ({
    a: ({ href, children }) => {
      const path = href ? markdownFilePath(href) : undefined;
      if (path !== undefined) return <MarkdownDownload botId={botId} path={path}>{children}</MarkdownDownload>;
      if (!href) return <span>{children}</span>;
      return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
    },
    img: ({ src, alt, title }) => {
      const path = src ? markdownFilePath(src) : undefined;
      if (path !== undefined) return <MarkdownDownload botId={botId} path={path}>{alt}</MarkdownDownload>;
      return src ? <img src={src} alt={alt} title={title} /> : <span>{alt}</span>;
    },
    // As in T3 Code, a wide table scrolls in its own box, so the thread never grows wider.
    table: ({ children }) => <div className="app-md-table"><table>{children}</table></div>,
  }), [botId]);
  return <Markdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>{text}</Markdown>;
});
