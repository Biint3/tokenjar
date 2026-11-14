'use strict';
// Render monospace text (optionally with basic ANSI colours) as a terminal-style SVG.

const COLORS = { 31: '#f07178', 32: '#9ece6a', 33: '#e0af68', 2: '#7a8296' };
const FG = '#d7dae0';

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Split a line into [{text, color}] runs using SGR codes 0/2/31/32/33. */
function runs(line) {
  const out = [];
  let color = FG;
  for (const part of line.split(/(\x1b\[\d+m)/)) {
    const m = part.match(/^\x1b\[(\d+)m$/);
    if (m) color = m[1] === '0' ? FG : COLORS[m[1]] || FG;
    else if (part) out.push({ text: part, color });
  }
  return out;
}

function terminal(title, text, { ansi = false } = {}) {
  const lines = text.split('\n');
  const charW = 8.4;
  const lineH = 20;
  const pad = 18;
  const top = 40;
  const width = Math.ceil(Math.max(60, ...lines.map((l) => [...l.replace(/\x1b\[\d+m/g, '')].length)) * charW + pad * 2);
  const height = top + lines.length * lineH + pad;
  // Every run is pinned to a fixed character grid (textLength), and the bar
  // glyphs ▓░ are drawn as rectangles, so alignment doesn't depend on fonts.
  const body = lines.map((l, i) => {
    const y = top + (i + 1) * lineH - 5;
    const parts = [];
    let col = 0;
    for (const r of ansi ? runs(l) : [{ text: l, color: FG }]) {
      for (const seg of [...r.text].reduce((acc, ch) => {
        const isBar = ch === '▓' || ch === '░';
        const last = acc[acc.length - 1];
        if (last && last.bar === isBar && !isBar) last.text += ch;
        else acc.push({ bar: isBar, text: ch, full: ch === '▓' });
        return acc;
      }, [])) {
        const x = pad + col * charW;
        const n = [...seg.text].length;
        if (seg.bar) {
          parts.push(`<rect x="${(x + 0.8).toFixed(1)}" y="${y - 12}" width="${(charW - 1.6).toFixed(1)}" height="14" rx="1.5" fill="${seg.full ? r.color : '#3a3f4b'}"/>`);
        } else if (seg.text.trim()) {
          parts.push(`<text x="${x.toFixed(1)}" y="${y}" fill="${r.color}" textLength="${(n * charW).toFixed(1)}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${esc(seg.text)}</text>`);
        }
        col += n;
      }
    }
    return parts.join('');
  }).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
  <rect width="${width}" height="${height}" rx="10" fill="#1e2129"/>
  <circle cx="20" cy="18" r="6" fill="#f07178"/><circle cx="40" cy="18" r="6" fill="#e0af68"/><circle cx="60" cy="18" r="6" fill="#9ece6a"/>
  <text x="${width / 2}" y="22" fill="#7a8296" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" text-anchor="middle">${esc(title)}</text>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="14">
  ${body}
  </g>
</svg>
`;
}

module.exports = { terminal };
