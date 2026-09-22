import { describe, expect, it } from 'vitest'
import { edgeDist2, parallelOffsets } from '../../src/curves'
import { EdgeIndex } from '../../src/grid'

describe('EdgeIndex', () => {
  it('pick matches brute force over a random graph with parallel edges', () => {
    let s = 5
    const rnd = () => (s = (1664525 * s + 1013904223) % 4294967296) / 4294967296
    const n = 300
    const pos = new Float32Array(2 * n)
    for (let i = 0; i < 2 * n; i++) pos[i] = rnd() * 2000
    const ends: number[] = []
    for (let i = 1; i < n; i++) ends.push(Math.floor(rnd() * i), i)
    for (let k = 0; k < 80; k++) { const a = Math.floor(rnd() * n), b = Math.floor(rnd() * n); if (a !== b) ends.push(a, b, b, a) }
    const off = parallelOffsets(ends, n, 16)
    const idx = new EdgeIndex()
    idx.build(pos, ends, off, 128)
    const tol = () => 4
    for (let q = 0; q < 400; q++) {
      const x = rnd() * 2000, y = rnd() * 2000
      let best = -1, bestD = Infinity
      for (let e = 0; e < ends.length / 2; e++) {
        const d = edgeDist2(x, y, pos[2 * ends[2 * e]], pos[2 * ends[2 * e] + 1], pos[2 * ends[2 * e + 1]], pos[2 * ends[2 * e + 1] + 1], off[e])
        if (d <= 16 && d < bestD) { bestD = d; best = e }
      }
      expect(idx.pick(pos, ends, off, x, y, tol)).toBe(best)
    }
  })

  it('hits an isolated edge at its midpoint and misses beside it', () => {
    const pos = new Float32Array([0, 0, 200, 0])
    const ends = [0, 1]
    const off = new Float32Array([0])
    const idx = new EdgeIndex()
    idx.build(pos, ends, off, 128)
    expect(idx.pick(pos, ends, off, 100, 1, () => 3)).toBe(0)
    expect(idx.pick(pos, ends, off, 100, 10, () => 3)).toBe(-1)
  })
})
