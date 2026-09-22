import type { BBox } from './types'

/**
 * A 2D camera: world → CSS-pixel mapping is `screen = (world - center) * zoom + viewport/2`.
 * `zoom` is CSS pixels per world unit. Y grows downward in both spaces, matching
 * canvas and cytoscape conventions.
 */
export class Camera {
  x = 0
  y = 0
  zoom = 1
  width = 1
  height = 1
  minZoom = 1e-3
  maxZoom = 1e3

  private anim: { from: [number, number, number]; to: [number, number, number]; start: number; duration: number } | null = null

  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
  }

  clampZoom(z: number): number {
    return Math.min(this.maxZoom, Math.max(this.minZoom, z))
  }

  worldToScreen(wx: number, wy: number): [number, number] {
    return [(wx - this.x) * this.zoom + this.width / 2, (wy - this.y) * this.zoom + this.height / 2]
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.width / 2) / this.zoom + this.x, (sy - this.height / 2) / this.zoom + this.y]
  }

  /** Pan by a screen-space delta. */
  panBy(dx: number, dy: number): void {
    this.x -= dx / this.zoom
    this.y -= dy / this.zoom
  }

  /** Multiply zoom by `factor`, keeping the world point under screen `(sx, sy)` fixed. */
  zoomAt(factor: number, sx: number, sy: number): void {
    const [wx, wy] = this.screenToWorld(sx, sy)
    this.zoom = this.clampZoom(this.zoom * factor)
    const [nx, ny] = this.screenToWorld(sx, sy)
    this.x += wx - nx
    this.y += wy - ny
  }

  /** Centre and zoom so `bbox` fits with `padding` CSS pixels on each side. */
  fit(bbox: BBox, padding = 0): void {
    const w = Math.max(bbox.x1 - bbox.x0, 1e-6)
    const h = Math.max(bbox.y1 - bbox.y0, 1e-6)
    const z = Math.min((this.width - 2 * padding) / w, (this.height - 2 * padding) / h)
    this.zoom = this.clampZoom(z)
    this.x = (bbox.x0 + bbox.x1) / 2
    this.y = (bbox.y0 + bbox.y1) / 2
  }

  /** The visible world rectangle. */
  visibleBounds(): BBox {
    const [x0, y0] = this.screenToWorld(0, 0)
    const [x1, y1] = this.screenToWorld(this.width, this.height)
    return { x0, y0, x1, y1 }
  }

  /** Column-major 3x3 matrix mapping world to clip space. */
  viewMatrix(out = new Float32Array(9)): Float32Array {
    const sx = (2 * this.zoom) / this.width
    const sy = (-2 * this.zoom) / this.height
    out[0] = sx
    out[1] = 0
    out[2] = 0
    out[3] = 0
    out[4] = sy
    out[5] = 0
    out[6] = -this.x * sx
    out[7] = -this.y * sy
    out[8] = 1
    return out
  }

  /** Start an eased animation toward a target; call `tick(now)` each frame. */
  animateTo(target: { x?: number; y?: number; zoom?: number }, duration: number, now: number): void {
    this.anim = {
      from: [this.x, this.y, this.zoom],
      to: [target.x ?? this.x, target.y ?? this.y, this.clampZoom(target.zoom ?? this.zoom)],
      start: now,
      duration,
    }
  }

  /** Advance the animation. Returns true while animating. */
  tick(now: number): boolean {
    const a = this.anim
    if (!a) return false
    const t = Math.min(1, (now - a.start) / a.duration)
    const e = 1 - (1 - t) * (1 - t) // ease-out quad
    this.x = a.from[0] + (a.to[0] - a.from[0]) * e
    this.y = a.from[1] + (a.to[1] - a.from[1]) * e
    // interpolate zoom geometrically so it feels linear
    this.zoom = a.from[2] * Math.pow(a.to[2] / a.from[2], e)
    if (t >= 1) this.anim = null
    return this.anim !== null
  }

  get animating(): boolean {
    return this.anim !== null
  }
}
