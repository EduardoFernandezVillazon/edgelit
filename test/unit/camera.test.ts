import { describe, expect, it } from 'vitest'
import { Camera } from '../../src/camera'

describe('Camera', () => {
  it('round-trips screen and world coordinates', () => {
    const c = new Camera()
    c.setViewport(800, 600)
    c.x = 120; c.y = -40; c.zoom = 2.5
    const [sx, sy] = c.worldToScreen(130, -30)
    expect(sx).toBeCloseTo(425)
    expect(sy).toBeCloseTo(325)
    const [wx, wy] = c.screenToWorld(sx, sy)
    expect(wx).toBeCloseTo(130)
    expect(wy).toBeCloseTo(-30)
  })

  it('zoomAt keeps the point under the cursor fixed', () => {
    const c = new Camera()
    c.setViewport(800, 600)
    c.zoom = 1
    const [wx, wy] = c.screenToWorld(100, 500)
    c.zoomAt(1.7, 100, 500)
    const [wx2, wy2] = c.screenToWorld(100, 500)
    expect(wx2).toBeCloseTo(wx)
    expect(wy2).toBeCloseTo(wy)
    expect(c.zoom).toBeCloseTo(1.7)
  })

  it('fit centres the box and respects padding and zoom limits', () => {
    const c = new Camera()
    c.setViewport(1000, 500)
    c.fit({ x0: -100, y0: -100, x1: 100, y1: 100 }, 50)
    expect(c.x).toBe(0)
    expect(c.y).toBe(0)
    expect(c.zoom).toBeCloseTo(2) // limited by height: (500-100)/200
    c.maxZoom = 1.5
    c.fit({ x0: 0, y0: 0, x1: 10, y1: 10 })
    expect(c.zoom).toBe(1.5)
  })

  it('view matrix maps the centre to clip origin and the right edge to +1', () => {
    const c = new Camera()
    c.setViewport(400, 200)
    c.x = 10; c.y = 20; c.zoom = 4
    const m = c.viewMatrix()
    const apply = (x: number, y: number) => [m[0] * x + m[6], m[4] * y + m[7]]
    const [cx, cy] = apply(10, 20)
    expect(cx).toBeCloseTo(0, 6)
    expect(cy).toBeCloseTo(0, 6)
    expect(apply(10 + 50, 20)[0]).toBeCloseTo(1)     // 50 world * 4 = 200 px = half width
    expect(apply(10, 20 + 25)[1]).toBeCloseTo(-1)    // y flipped
  })

  it('animates toward a target and stops', () => {
    const c = new Camera()
    c.setViewport(100, 100)
    c.animateTo({ x: 100, zoom: 4 }, 100, 0)
    expect(c.tick(50)).toBe(true)
    expect(c.x).toBeGreaterThan(0)
    expect(c.tick(100)).toBe(false)
    expect(c.x).toBe(100)
    expect(c.zoom).toBeCloseTo(4)
  })
})
