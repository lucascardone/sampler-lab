// The user manual (manual.md) split into parts ("# …": PC / phone) and sections ("## …").
import raw from "./manual.md?raw";

export interface Section {
  id: string;
  title: string;
  /** Markdown of the section body (paragraphs, lists, **bold**, `code`). */
  body: string;
}
export interface Part {
  title: string;
  sections: Section[];
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export function parseManual(md: string): Part[] {
  const parts: Part[] = [];
  let section: Section | null = null;
  for (const line of md.split(/\r?\n/)) {
    if (line.startsWith("# ")) {
      parts.push({ title: line.slice(2).trim(), sections: [] });
      section = null;
    } else if (line.startsWith("## ")) {
      const part = parts[parts.length - 1];
      if (!part) continue;
      const title = line.slice(3).trim();
      section = { id: `${slug(part.title)}-${slug(title)}`, title, body: "" };
      part.sections.push(section);
    } else if (section) {
      section.body += line + "\n";
    }
  }
  for (const p of parts) for (const s of p.sections) s.body = s.body.trim();
  return parts;
}

export const MANUAL = parseManual(raw);
