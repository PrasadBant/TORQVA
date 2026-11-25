// Layout of the measurement callouts around the 3D viewport (pure, no DOM). Cards are stacked in a left and a right column, ordered by the screen
// height of the part they describe, so leader lines do not cross and cards never overlap.

/**
 * points: [{ id, x, y }] for the anchors currently in view. Returns [{ id, side: 'left' | 'right', x, y, ax, ay }] where (x, y) is the card's top-left
 * corner and (ax, ay) the anchor its leader line ends at. Points that do not fit in either column are left out.
 */
export function layoutCallouts(points, { w, h, cardW = 170, cardH = 48, gap = 8, margin = 10 } = {}) {
  if (!points.length || w < cardW * 2 + margin * 4 || h < cardH + margin * 2) return [];
  const cap = Math.max(0, Math.floor((h - 2 * margin + gap) / (cardH + gap)));
  let left = points.filter((p) => p.x < w / 2), right = points.filter((p) => p.x >= w / 2);
  // balance: move the anchors nearest the centre line to the other column when one column is over capacity
  const byCentre = (a, b) => Math.abs(b.x - w / 2) - Math.abs(a.x - w / 2);
  while (left.length > cap && right.length < cap) { left.sort(byCentre); right.push(left.pop()); }
  while (right.length > cap && left.length < cap) { right.sort(byCentre); left.push(right.pop()); }
  const out = [];
  for (const [side, list] of [['left', left], ['right', right]]) {
    const col = list.slice().sort((a, b) => a.y - b.y).slice(0, cap);
    const tops = col.map((p) => Math.min(Math.max(p.y - cardH / 2, margin), h - margin - cardH));
    for (let i = 1; i < tops.length; i++) tops[i] = Math.max(tops[i], tops[i - 1] + cardH + gap);                 // push down
    if (tops.length) tops[tops.length - 1] = Math.min(tops[tops.length - 1], h - margin - cardH);
    for (let i = tops.length - 2; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - cardH - gap);            // then pull up
    col.forEach((p, i) => out.push({ id: p.id, side, x: side === 'left' ? margin : w - margin - cardW, y: Math.max(margin, tops[i]), ax: p.x, ay: p.y }));
  }
  return out;
}
