// A bot's words as markdown.
import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Links open in the browser (the desktop shell sends new windows there). Raw HTML is not rendered.
// A table sits in a box of its own that scrolls sideways when the table is wider than the chat,
// as T3 Code's chat-markdown-table-container does, so the page never grows wider.
export const mdComponents: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="app-md-table">
      <table>{children}</table>
    </div>
  ),
};

export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
      {text}
    </Markdown>
  );
});
