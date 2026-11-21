// Read-only picture of a channel's piano-roll notes for the phone: the same glowing tubes
// and glide curves as the PC's piano roll, scaled to fit, so you can see the melody even
// though notes are edited on the PC.
import { glideFrom, type Note } from "../studio/song";

const W = 320;
const H = 120;
const PAD = 6;

export function NotesPreview({ notes, steps, color }: { notes: Note[]; steps: number; color: string }) {
  if (!notes.length) return null;
  const ps = notes.map((n) => n.pitch);
  const lo = Math.min(...ps) - 1;
  const hi = Math.max(...ps) + 1;
  const x = (step: number) => PAD + (step / steps) * (W - 2 * PAD);
  const y = (p: number) => PAD + ((hi - p) / Math.max(1, hi - lo)) * (H - 2 * PAD);
  const thick = Math.max(3, Math.min(8, (H - 2 * PAD) / (hi - lo + 1) - 1));
  return (
    <svg className="m-notes" viewBox={`0 0 ${W} ${H}`} style={{ "--ch": color } as React.CSSProperties} aria-hidden="true">
      {Array.from({ length: Math.floor(steps / 4) + 1 }, (_, i) => (
        <line key={i} className={i % 4 === 0 ? "bar" : ""} x1={x(i * 4)} x2={x(i * 4)} y1={0} y2={H} />
      ))}
      {notes.map((n, i) => {
        const from = n.glide ? glideFrom(notes, i) : n.pitch;
        const g = from !== n.pitch ? Math.min(n.glide ?? 0, n.length) : 0;
        const x0 = x(n.start);
        const xg = x(n.start + g);
        const x1 = x(n.start + n.length) - 1;
        return (
          <g key={i} strokeWidth={thick} style={{ opacity: 0.5 + 0.5 * n.velocity }}>
            {g > 0 && <path d={`M${x0} ${y(from)} C${(x0 + xg) / 2} ${y(from)} ${(x0 + xg) / 2} ${y(n.pitch)} ${xg} ${y(n.pitch)}`} />}
            {x1 > xg && <line x1={xg} x2={x1} y1={y(n.pitch)} y2={y(n.pitch)} />}
          </g>
        );
      })}
    </svg>
  );
}
