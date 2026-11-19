/**
 * Words that take turns in one place: every one is laid out in the same cell, only the shown one is
 * seen and read out, so the box keeps the size of the longest and nothing around it moves.
 */
export function Swap({ lines, shown, className = "", lineClass = "" }: { lines: string[]; shown: string; className?: string; lineClass?: string | ((line: string) => string) }) {
  const all = lines.includes(shown) ? lines : [...lines, shown];
  return (
    <span className={`pb-swap ${className}`.trim()}>
      {all.map((line) => (
        <span
          key={line}
          className={`pb-swap-line ${typeof lineClass === "function" ? lineClass(line) : lineClass}`.trim()}
          data-show={line === shown || undefined}
          aria-hidden={line !== shown || undefined}
        >
          {line}
        </span>
      ))}
    </span>
  );
}
