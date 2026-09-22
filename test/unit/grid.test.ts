import { describe, expect, it } from 'vitest'
import { SpatialGrid } from '../../src/grid'

function points(n: number): Float32Array {
  let s = 3
  const rnd = () => (s = (1664525 * s + 1013904223) % 4294967296) / 4294967296
  const p = new Float32Array(2 * n)
  for (let i = 0; i < 2 * n; i++) p[i] = rnd() * 1000
  return p
}

describe('SpatialGrid', () => {
  it('pick matches brute force', () => {
    const n = 2000
    const p = points(n)
    const g = new SpatialGrid()
    g.build(p, n, 40)
    const radius = (i: number) => 5 + (i % 7)
    let s = 11
    const rnd = () => (s = (1664525 * s + 1013904223) % 4294967296) / 4294967296
    for (let k = 0; k < 500; k++) {
      const x = rnd() * 1000, y = rnd() * 1000
      let best = -1, bestD = Infinity
      for (let i = 0; i < n; i++) {
        const dx = p[2 * i] - x, dy = p[2 * i + 1] - y, d = dx * dx + dy * dy
        if (d <= radius(i) ** 2 && d < bestD) { bestD = d; best = i }
      }
      expect(g.pick(p, x, y, radius, 12)).toBe(best)
    }
  })

  it('respects the accept filter', () => {
    const p = new Float32Array([0, 0, 1, 1])
    const g = new SpatialGrid()
    g.build(p, 2, 10)
    expect(g.pick(p, 0.4, 0.4, () => 1, 1)).toBe(0)
    expect(g.pick(p, 0.4, 0.4, () => 1, 1, (i) => i !== 0)).toBe(1)
  })

  it('queryRect returns exactly the contained points', () => {
    const n = 1000
    const p = points(n)
    const g = new SpatialGrid()
    g.build(p, n, 25)
    const got = g.queryRect(p, 200, 300, 450, 620).sort((a, b) => a - b)
    const want: number[] = []
    for (let i = 0; i < n; i++) if (p[2 * i] >= 200 && p[2 * i] <= 450 && p[2 * i + 1] >= 300 && p[2 * i + 1] <= 620) want.push(i)
    expect(got).toEqual(want)
  })

  it('handles an empty grid', () => {
    const g = new SpatialGrid()
    g.build(new Float32Array(0), 0, 10)
    expect(g.pick(new Float32Array(0), 0, 0, () => 1, 1)).toBe(-1)
  })
})
