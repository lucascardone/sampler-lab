// Tiny Markdown renderer for the manual: paragraphs, "-" and "1." lists, **bold** and
// `code`. Builds React elements (no raw HTML).
import type { ReactNode } from "react";

export type Block = { kind: "p"; text: string } | { kind: "ul" | "ol"; items: string[] };

export function blocks(md: string): Block[] {
  const out: Block[] = [];
  for (const chunk of md.split(/\n\s*\n/)) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (lines.every((l) => l.startsWith("- "))) out.push({ kind: "ul", items: lines.map((l) => l.slice(2)) });
    else if (lines.every((l) => /^\d+\.\s/.test(l))) out.push({ kind: "ol", items: lines.map((l) => l.replace(/^\d+\.\s/, "")) });
    else out.push({ kind: "p", text: lines.join(" ") });
  }
  return out;
}

export function inline(text: string): ReactNode[] {
  // **bold** and `code`, everything else as text.
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    return part;
  });
}

export function Markdown({ source }: { source: string }) {
  return (
    <>
      {blocks(source).map((b, i) =>
        b.kind === "p" ? (
          <p key={i}>{inline(b.text)}</p>
        ) : b.kind === "ul" ? (
          <ul key={i}>
            {b.items.map((it, j) => (
              <li key={j}>{inline(it)}</li>
            ))}
          </ul>
        ) : (
          <ol key={i}>
            {b.items.map((it, j) => (
              <li key={j}>{inline(it)}</li>
            ))}
          </ol>
        ),
      )}
    </>
  );
}
