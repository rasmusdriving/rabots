// Trial: the text of a PDF with macOS's own PDFKit, no dependency. JavaScript for Automation:
//   osascript -l JavaScript scripts/dev/pdf-text.js /path/to/file.pdf
// Prints the text of every page, or "NO TEXT" when the PDF has none (a scan).
ObjC.import("PDFKit");
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) return "NOT A PDF";
  const s = doc.string;
  const text = s && !s.isNil() ? s.js : "";
  return `${doc.pageCount} page(s)\n` + (text.trim() ? text : "NO TEXT");
}
