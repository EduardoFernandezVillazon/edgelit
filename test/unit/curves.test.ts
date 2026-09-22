import { describe, expect, it } from 'vitest'
import { controlPoint, edgeDist2, parallelOffsets, quadAt, segmentDist2 } from '../../src/curves'

describe('parallelOffsets', () => {
  it('leaves single edges straight and fans pairs symmetrically', () => {
    const ends = [0, 1, 1, 0, 2, 3]
    const off = parallelOffsets(ends, 4, 10)
    expect(off[2]).toBe(0)
    // A→B and B→A: canonical offsets -5 and +5; the reversed edge flips sign,
    // so both end up on the same canonical side... unless flipped: they must differ.
    expect(Math.abs(off[0])).toBe(5)
    expect(Math.abs(off[1])).toBe(5)
    // In world space the two curves must be on opposite sides of the chord.
    // Edge 0 (0→1) bends along its own left normal by off[0]; edge 1 (1→0)
    // bends along the opposite normal by off[1]; opposite sides ⇔ off[0] === off[1]... derive:
    const side0 = off[0]            // left normal of 0→1
    const side1 = -off[1]           // left normal of 1→0 is minus that of 0→1
    expect(Math.sign(side0)).not.toBe(Math.sign(side1))
  })

  it('assigns a straight middle edge for odd groups and skips self-loops', () => {
    const ends = [0, 1, 0, 1, 0, 1, 2, 2]
    const off = parallelOffsets(ends, 3, 8)
    expect(Array.from(off.slice(0, 3)).sort((a, b) => a - b)).toEqual([-8, 0, 8])
    expect(off[3]).toBe(0)
  })

  it('is all zeros with zero spacing', () => {
    expect(Array.from(parallelOffsets([0, 1, 1, 0], 2, 0))).toEqual([0, 0])
  })
})

describe('quadratic helpers', () => {
  it('curve passes `offset` from the chord midpoint at t = 0.5', () => {
    const [cx, cy] = controlPoint(0, 0, 100, 0, 12)
    const [mx, my] = quadAt(0, 0, cx, cy, 100, 0, 0.5)
    expect(mx).toBeCloseTo(50)
    expect(Math.abs(my)).toBeCloseTo(12)
  })

  it('segment distance handles endpoints and interior', () => {
    expect(Math.sqrt(segmentDist2(5, 3, 0, 0, 10, 0))).toBeCloseTo(3)
    expect(Math.sqrt(segmentDist2(-4, 3, 0, 0, 10, 0))).toBeCloseTo(5)
  })

  it('edge distance uses the curve when offset is non-zero', () => {
    // point at the curve's midpoint: distance ≈ 0 for the curve, 12 for the chord
    const [cx, cy] = controlPoint(0, 0, 100, 0, 12)
    const [mx, my] = quadAt(0, 0, cx, cy, 100, 0, 0.5)
    expect(Math.sqrt(edgeDist2(mx, my, 0, 0, 100, 0, 12))).toBeLessThan(0.5)
    expect(Math.sqrt(edgeDist2(mx, my, 0, 0, 100, 0, 0))).toBeCloseTo(12)
  })
})
