import { edgeDist2 } from './curves'

/**
 * Uniform spatial hash over node centres for CPU picking. Rebuilt whenever
 * positions change; O(n) and allocation-free after the first build.
 */
export class SpatialGrid {
  private cell = 64
  private cols = 0
  private rows = 0
  private x0 = 0
  private y0 = 0
  private cellStart = new Int32Array(0)
  private items = new Int32Array(0)
  private count = 0

  /** `pos` interleaved xy; `cell` should be at least the largest node diameter. */
  build(pos: Float32Array, count: number, cell: number): void {
    this.count = count
    this.cell = Math.max(cell, 1e-6)
    if (count === 0) {
      this.cols = this.rows = 0
      return
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let i = 0; i < count; i++) {
      const x = pos[2 * i], y = pos[2 * i + 1]
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    this.x0 = x0
    this.y0 = y0
    this.cols = Math.max(1, Math.min(4096, Math.floor((x1 - x0) / this.cell) + 1))
    this.rows = Math.max(1, Math.min(4096, Math.floor((y1 - y0) / this.cell) + 1))
    const ncell = this.cols * this.rows
    if (this.cellStart.length < ncell + 1) this.cellStart = new Int32Array(ncell + 1)
    else this.cellStart.fill(0, 0, ncell + 1)
    if (this.items.length < count) this.items = new Int32Array(count)
    // counting sort into cells
    const cs = this.cellStart
    for (let i = 0; i < count; i++) cs[this.cellOf(pos[2 * i], pos[2 * i + 1]) + 1]++
    for (let c = 0; c < ncell; c++) cs[c + 1] += cs[c]
    const fill = new Int32Array(ncell)
    for (let i = 0; i < count; i++) {
      const c = this.cellOf(pos[2 * i], pos[2 * i + 1])
      this.items[cs[c] + fill[c]++] = i
    }
  }

  private cellOf(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.x0) / this.cell)))
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.y0) / this.cell)))
    return cy * this.cols + cx
  }

  /**
   * Nearest node whose circle of radius `radius(i)` contains `(x, y)`;
   * ties broken by smallest distance. `maxRadius` bounds the search.
   */
  pick(pos: Float32Array, x: number, y: number, radius: (i: number) => number, maxRadius: number, accept?: (i: number) => boolean): number {
    if (this.count === 0) return -1
    const r = Math.ceil(maxRadius / this.cell)
    const cx = Math.floor((x - this.x0) / this.cell)
    const cy = Math.floor((y - this.y0) / this.cell)
    let best = -1, bestD = Infinity
    for (let j = cy - r; j <= cy + r; j++) {
      if (j < 0 || j >= this.rows) continue
      for (let i = cx - r; i <= cx + r; i++) {
        if (i < 0 || i >= this.cols) continue
        const c = j * this.cols + i
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const n = this.items[k]
          if (accept && !accept(n)) continue
          const dx = pos[2 * n] - x, dy = pos[2 * n + 1] - y
          const d = dx * dx + dy * dy
          const rr = radius(n)
          if (d <= rr * rr && d < bestD) {
            bestD = d
            best = n
          }
        }
      }
    }
    return best
  }

  /** Indices of nodes whose centre lies inside the rectangle. */
  queryRect(pos: Float32Array, x0: number, y0: number, x1: number, y1: number, out: number[] = []): number[] {
    if (this.count === 0) return out
    const ci0 = Math.max(0, Math.floor((x0 - this.x0) / this.cell))
    const ci1 = Math.min(this.cols - 1, Math.floor((x1 - this.x0) / this.cell))
    const cj0 = Math.max(0, Math.floor((y0 - this.y0) / this.cell))
    const cj1 = Math.min(this.rows - 1, Math.floor((y1 - this.y0) / this.cell))
    for (let j = cj0; j <= cj1; j++)
      for (let i = ci0; i <= ci1; i++) {
        const c = j * this.cols + i
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const n = this.items[k]
          const x = pos[2 * n], y = pos[2 * n + 1]
          if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.push(n)
        }
      }
    return out
  }
}


/**
 * Uniform grid over edge bounding boxes for edge picking. An edge is
 * registered in every cell its (offset-expanded) chord box overlaps.
 */
export class EdgeIndex {
  private cell = 128
  private cols = 0
  private rows = 0
  private x0 = 0
  private y0 = 0
  private cellStart = new Int32Array(0)
  private items = new Int32Array(0)
  private count = 0

  build(pos: Float32Array, ends: ArrayLike<number>, offsets: Float32Array, cell: number): void {
    const m = ends.length / 2
    this.count = m
    this.cell = Math.max(cell, 1e-6)
    if (m === 0) {
      this.cols = this.rows = 0
      return
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let i = 0; i < m; i++) {
      for (const n of [ends[2 * i], ends[2 * i + 1]]) {
        const x = pos[2 * n], y = pos[2 * n + 1]
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
    this.x0 = x0
    this.y0 = y0
    this.cols = Math.max(1, Math.min(2048, Math.floor((x1 - x0) / this.cell) + 1))
    this.rows = Math.max(1, Math.min(2048, Math.floor((y1 - y0) / this.cell) + 1))
    const ncell = this.cols * this.rows
    if (this.cellStart.length < ncell + 1) this.cellStart = new Int32Array(ncell + 1)
    else this.cellStart.fill(0, 0, ncell + 1)
    const cs = this.cellStart
    // pass 1: count memberships
    let total = 0
    const box = (i: number): [number, number, number, number] => {
      const s = ends[2 * i], t = ends[2 * i + 1]
      const pad = Math.abs(offsets[i])
      const ax = pos[2 * s], ay = pos[2 * s + 1], bx = pos[2 * t], by = pos[2 * t + 1]
      return [
        this.ci(Math.min(ax, bx) - pad), this.cj(Math.min(ay, by) - pad),
        this.ci(Math.max(ax, bx) + pad), this.cj(Math.max(ay, by) + pad),
      ]
    }
    for (let i = 0; i < m; i++) {
      const [i0, j0, i1, j1] = box(i)
      for (let j = j0; j <= j1; j++) for (let c = i0; c <= i1; c++) { cs[j * this.cols + c + 1]++; total++ }
    }
    for (let c = 0; c < ncell; c++) cs[c + 1] += cs[c]
    if (this.items.length < total) this.items = new Int32Array(total)
    const fill = new Int32Array(ncell)
    for (let i = 0; i < m; i++) {
      const [i0, j0, i1, j1] = box(i)
      for (let j = j0; j <= j1; j++) for (let c = i0; c <= i1; c++) {
        const k = j * this.cols + c
        this.items[cs[k] + fill[k]++] = i
      }
    }
  }

  private ci(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.x0) / this.cell)))
  }
  private cj(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.y0) / this.cell)))
  }

  /** Nearest edge within `tolerance(i)` (world units, measured to the edge's centre line) of the point. */
  pick(pos: Float32Array, ends: ArrayLike<number>, offsets: Float32Array, x: number, y: number, tolerance: (i: number) => number, accept?: (i: number) => boolean): number {
    if (this.count === 0) return -1
    const i0 = this.ci(x - this.cell), i1 = this.ci(x + this.cell)
    const j0 = this.cj(y - this.cell), j1 = this.cj(y + this.cell)
    let best = -1, bestD = Infinity
    const seen = new Set<number>()
    for (let j = j0; j <= j1; j++)
      for (let c = i0; c <= i1; c++) {
        const k = j * this.cols + c
        for (let q = this.cellStart[k]; q < this.cellStart[k + 1]; q++) {
          const e = this.items[q]
          if (seen.has(e)) continue
          seen.add(e)
          if (accept && !accept(e)) continue
          const s = ends[2 * e], t = ends[2 * e + 1]
          const d = edgeDist2(x, y, pos[2 * s], pos[2 * s + 1], pos[2 * t], pos[2 * t + 1], offsets[e])
          const tol = tolerance(e)
          if (d <= tol * tol && d < bestD) {
            bestD = d
            best = e
          }
        }
      }
    return best
  }
}
