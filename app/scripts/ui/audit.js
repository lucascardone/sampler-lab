// UI check (dev only): __audit(minTarget) measures the rendered page — WCAG text contrast, controls smaller than minTarget px (24 PC / 44 phone), unnamed buttons and horizontal overflow. Used with shoot.mjs; see .agents/testing.md.
window.__audit = (minTarget = 24) => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const blend = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } } let out = { r: 21, g: 23, b: 28, a: 1 }; for (let i = stack.length - 1; i >= 0; i--) out = blend(stack[i], out); return out; };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
  const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const small = [], unnamed = [], lowContrast = [];
  for (const el of document.querySelectorAll('button, input, select, summary, [role=button], a[href]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if ((r.width < minTarget || r.height < minTarget) && el.type !== 'checkbox' && el.type !== 'range') small.push(`${name(el) || el.tagName} ${Math.round(r.width)}x${Math.round(r.height)} .${(el.className || '').toString().split(' ')[0]}`);
    if (!name(el) && el.tagName !== 'INPUT') unnamed.push(el.outerHTML.slice(0, 90));
  }
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const s = getComputedStyle(el);
    const fg = parse(s.color); if (!fg) continue;
    let op = 1; for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
    if (el.closest(':disabled,[disabled]')) continue;
    const bg = bgOf(el);
    const f = blend({ ...fg, a: fg.a * op }, bg);
    const L1 = lum(f), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(s.fontSize), bold = Number(s.fontWeight) >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    if (ratio < need) { const k = `${el.textContent.trim().slice(0, 30)}|${ratio.toFixed(2)}`; if (!seen.has(k)) { seen.add(k); lowContrast.push(`${ratio.toFixed(2)} "${el.textContent.trim().slice(0, 30)}" ${size}px .${(el.className || '').toString().split(' ')[0]}`); } }
  }
  return { overflowX: document.documentElement.scrollWidth > innerWidth + 1, small: small.slice(0, 40), smallCount: small.length, unnamed: unnamed.slice(0, 10), lowContrast: lowContrast.slice(0, 40), lowCount: lowContrast.length };
};
