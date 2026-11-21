// Who to credit for a song: the pack sounds it uses, with author and license. CC-BY
// sounds require naming the author when the song is published; we make that one click.
import type { PackInfo } from "../../lib/api";
import type { Song } from "../studio/song";

export interface Credit {
  /** What the song calls it (the channel). */
  sound: string;
  pack: string;
  author: string;
  license: string;
  url?: string;
  /** The license asks to name the author (CC-BY…). */
  required: boolean;
}

// CC-BY asks to name the author; MIT/BSD ask to keep the copyright notice.
const needsCredit = (license: string) => /^(CC-BY|MIT|BSD)/i.test(license);

/** Credits for every pack sound the song uses (own sounds and missing packs left out). */
export function songCredits(song: Song, packs: PackInfo[]): Credit[] {
  const byId = new Map(packs.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: Credit[] = [];
  for (const ch of song.channels) {
    if (ch.sound.kind !== "pack" && ch.sound.kind !== "instrument") continue;
    const pack = byId.get(ch.sound.packId);
    const item = pack?.items.find((i) => i.id === (ch.sound as { itemId: string }).itemId);
    if (!pack || !item) continue;
    const author = item.credit?.author ?? pack.author;
    const license = item.credit?.license ?? pack.license;
    if (license === "own") continue;
    const key = `${pack.id}/${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      sound: item.name,
      pack: pack.name,
      author,
      license,
      url: item.credit?.url ?? pack.sourceUrl,
      required: needsCredit(license),
    });
  }
  return out;
}

/** creditos.txt: one line per sound, required ones first. */
export function creditsText(title: string, credits: Credit[], labels: { heading: string; by: string; license: string }): string {
  const sorted = [...credits].sort((a, b) => Number(b.required) - Number(a.required) || a.pack.localeCompare(b.pack));
  const lines = sorted.map((c) => `- ${c.sound} (${c.pack}) — ${labels.by} ${c.author || "?"} — ${labels.license} ${c.license}${c.url ? ` — ${c.url}` : ""}`);
  return [`${labels.heading}: ${title}`, "", ...lines, ""].join("\r\n");
}
