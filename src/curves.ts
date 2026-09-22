/**
 * Parallel-edge fan-out and quadratic-curve helpers shared by the CPU side
 * (picking, tests) and mirrored in the shaders.
 */

/**
 * Sideways offset per edge in world units. Edges sharing an unordered node
 * pair are spread symmetrically around the chord: for k parallel edges,
 * the j-th gets `(j - (k-1)/2) * spacing`. Offsets are expressed relative
 * to the pair's canonical orientation (lower index → higher index) and then
 * signed for the edge's own direction, so A→B and B→A bend to opposite
 * sides. Self-loops get 0 (they are not drawn).
 */
export function parallelOffsets(ends: ArrayLike<number>, nodeCount: number, spacing: number): Float32Array<ArrayBuffer> {
  const m = ends.length / 2
  const out = new Float32Array(m)
  if (m === 0 || spacing === 0) return out
  const groups = new Map<number, number[]>()
  for (let i = 0; i < m; i++) {
    const s = ends[2 * i], t = ends[2 * i + 1]
    if (s === t) continue
    const key = Math.min(s, t) * nodeCount + Math.max(s, t)
    let g = groups.get(key)
    if (!g) groups.set(key, (g = []))
    g.push(i)
  }
  for (const g of groups.values()) {
    const k = g.length
    if (k < 2) continue
    for (let j = 0; j < k; j++) {
      const i = g[j]
      const canonical = (j - (k - 1) / 2) * spacing
      out[i] = ends[2 * i] < ends[2 * i + 1] ? canonical : -canonical
    }
  }
  return out
}

/** Point on the quadratic through p0, control p1, p2 at parameter t. */
export function quadAt(p0x: number, p0y: number, p1x: number, p1y: number, p2x: number, p2y: number, t: number): [number, number] {
  const u = 1 - t
  const a = u * u, b = 2 * u * t, c = t * t
  return [a * p0x + b * p1x + c * p2x, a * p0y + b * p1y + c * p2y]
}

/** Control point for an edge from (sx,sy) to (tx,ty) whose midpoint is displaced by `offset` along the left normal. */
export function controlPoint(sx: number, sy: number, tx: number, ty: number, offset: number): [number, number] {
  const dx = tx - sx, dy = ty - sy
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len, ny = dx / len
  return [(sx + tx) / 2 + nx * 2 * offset, (sy + ty) / 2 + ny * 2 * offset]
}

/** Squared distance from a point to a segment. */
export function segmentDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay
  const l2 = vx * vx + vy * vy
  let t = l2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = ax + t * vx - px, cy = ay + t * vy - py
  return cx * cx + cy * cy
}

/** Number of samples used to approximate a curved edge as a polyline when picking. */
export const PICK_SAMPLES = 8

/** Squared distance from a point to an edge (straight when offset is 0, else a sampled quadratic). */
export function edgeDist2(px: number, py: number, sx: number, sy: number, tx: number, ty: number, offset: number): number {
  if (offset === 0) return segmentDist2(px, py, sx, sy, tx, ty)
  const [cx, cy] = controlPoint(sx, sy, tx, ty, offset)
  let best = Infinity
  let [ax, ay] = [sx, sy]
  for (let i = 1; i <= PICK_SAMPLES; i++) {
    const [bx, by] = quadAt(sx, sy, cx, cy, tx, ty, i / PICK_SAMPLES)
    const d = segmentDist2(px, py, ax, ay, bx, by)
    if (d < best) best = d
    ax = bx
    ay = by
  }
  return best
}
