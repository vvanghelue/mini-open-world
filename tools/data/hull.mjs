// Tight enclosing polygons for alpha-tested sprites ("particle trimming"): convex hull of the opaque texels,
// then greedy edge removal (extend both neighbour edges to their intersection) picking the smallest added area,
// until k vertices remain. The polygon always contains every opaque texel.

/** Andrew monotone chain; points [[x,y]...] -> CCW hull (y up or down: orientation follows the input). */
export function convexHull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(a) / 2;
}

function lineIntersect(p1, p2, p3, p4) {
  const d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / d;
  return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
}

/** Reduces a convex CCW polygon to k vertices by removing edges (minimal added area), staying enclosing. */
export function reduceHull(hull, k) {
  let poly = hull.slice();
  while (poly.length > k) {
    let best = -1, bestArea = Infinity, bestPt = null;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      // remove edge (i, i+1): intersect the lines of edges (i-1, i) and (i+1, i+2)
      const a = poly[(i - 1 + n) % n], b = poly[i], c = poly[(i + 1) % n], d = poly[(i + 2) % n];
      const x = lineIntersect(a, b, c, d);
      if (!x) continue;
      // the intersection must lie beyond b (along a->b) and before c (along d->c), else the edges diverge
      const along1 = (x[0] - b[0]) * (b[0] - a[0]) + (x[1] - b[1]) * (b[1] - a[1]);
      const along2 = (x[0] - c[0]) * (c[0] - d[0]) + (x[1] - c[1]) * (c[1] - d[1]);
      if (along1 < 0 || along2 < 0) continue;
      const area = polygonArea([b, x, c]);
      if (area < bestArea) { bestArea = area; best = i; bestPt = x; }
    }
    if (best < 0) break;
    const n2 = poly.length;
    const next = (best + 1) % n2;
    poly[best] = bestPt;
    poly.splice(next, 1);
  }
  return poly;
}
