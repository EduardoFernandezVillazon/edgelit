import type { Camera } from './camera'
import type { Emitter } from './events'
import type { EventMap, PointerInfo } from './types'

export interface InteractionHost {
  canvas: HTMLCanvasElement
  camera: Camera
  events: Emitter<EventMap>
  pick(clientX: number, clientY: number): number
  pickEdge(clientX: number, clientY: number): number
  edgeEnds(edge: number): [number, number]
  requestRender(): void
  wheelZoomFactor: number
}

const DRAG_THRESHOLD_PX = 3

/** Pointer handling: hover, click, double click, context menu, node drag, pan, wheel zoom. */
export class Interaction {
  private down: { x: number; y: number; node: number; edge: number; id: number } | null = null
  private dragging = false
  private hovered = -1
  private hoveredEdgeIdx = -1
  private hoverPending: { x: number; y: number; ev: PointerEvent } | null = null
  private disposers: Array<() => void> = []
  nodeDragEnabled = true

  constructor(private host: InteractionHost) {
    const c = host.canvas
    c.style.touchAction = 'none'
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      c.addEventListener(type, fn, opts)
      this.disposers.push(() => c.removeEventListener(type, fn, opts))
    }
    on('pointerdown', (e) => this.onDown(e))
    on('pointermove', (e) => this.onMove(e))
    on('pointerup', (e) => this.onUp(e))
    on('pointercancel', (e) => this.onUp(e))
    on('pointerleave', (e) => this.setHover(-1, -1, e))
    on('wheel', (e) => this.onWheel(e), { passive: false })
    on('dblclick', (e) => this.host.events.emit('dblclick', this.infoAt(e)))
    on('contextmenu', (e) => {
      e.preventDefault()
      this.host.events.emit('contextmenu', this.infoAt(e))
    })
  }

  private local(e: MouseEvent): [number, number] {
    const r = this.host.canvas.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  private info(e: PointerEvent | MouseEvent | WheelEvent, node: number, edge = -1): PointerInfo {
    const [cx, cy] = this.local(e)
    const [x, y] = this.host.camera.screenToWorld(cx, cy)
    const [source, target] = edge >= 0 ? this.host.edgeEnds(edge) : [-1, -1]
    return { node, edge, source, target, x, y, clientX: cx, clientY: cy, originalEvent: e }
  }

  /** Node first, then edge, at the pointer. */
  private infoAt(e: PointerEvent | MouseEvent): PointerInfo {
    const [x, y] = this.local(e)
    const node = this.host.pick(x, y)
    const edge = node >= 0 ? -1 : this.host.pickEdge(x, y)
    return this.info(e, node, edge)
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return
    const [x, y] = this.local(e)
    const node = this.host.pick(x, y)
    const edge = node >= 0 ? -1 : this.host.pickEdge(x, y)
    this.down = { x, y, node, edge, id: e.pointerId }
    this.dragging = false
    this.host.canvas.setPointerCapture(e.pointerId)
  }

  private onMove(e: PointerEvent): void {
    const [x, y] = this.local(e)
    const d = this.down
    if (d && d.id === e.pointerId) {
      if (!this.dragging && Math.hypot(x - d.x, y - d.y) >= DRAG_THRESHOLD_PX) {
        this.dragging = true
        if (d.node >= 0 && this.nodeDragEnabled) this.host.events.emit('dragstart', this.info(e, d.node))
      }
      if (this.dragging) {
        if (d.node >= 0 && this.nodeDragEnabled) {
          this.host.events.emit('drag', this.info(e, d.node))
        } else {
          this.host.camera.panBy(x - d.x, y - d.y)
          d.x = x
          d.y = y
          this.emitViewport()
          this.host.requestRender()
        }
      }
      return
    }
    // Hover: pick at most once per frame.
    if (!this.hoverPending) requestAnimationFrame(() => {
      const p = this.hoverPending
      this.hoverPending = null
      if (!p) return
      const node = this.host.pick(p.x, p.y)
      const edge = node >= 0 ? -1 : this.host.pickEdge(p.x, p.y)
      this.setHover(node, edge, p.ev)
    })
    this.hoverPending = { x, y, ev: e }
  }

  private onUp(e: PointerEvent): void {
    const d = this.down
    if (!d || d.id !== e.pointerId) return
    this.down = null
    if (this.host.canvas.hasPointerCapture(e.pointerId)) this.host.canvas.releasePointerCapture(e.pointerId)
    if (this.dragging) {
      if (d.node >= 0 && this.nodeDragEnabled) this.host.events.emit('dragend', this.info(e, d.node))
      this.dragging = false
      return
    }
    if (e.type === 'pointerup') this.host.events.emit('click', this.info(e, d.node, d.edge))
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    const [x, y] = this.local(e)
    const notches = e.deltaMode === 1 ? e.deltaY : e.deltaY / 100
    const factor = Math.pow(this.host.wheelZoomFactor, -notches)
    this.host.camera.zoomAt(factor, x, y)
    this.emitViewport()
    this.host.requestRender()
  }

  private setHover(node: number, edge: number, e: PointerEvent): void {
    if (node === this.hovered && edge === this.hoveredEdgeIdx) return
    this.hovered = node
    this.hoveredEdgeIdx = edge
    this.host.events.emit('hover', this.info(e, node, edge))
  }

  private emitViewport(): void {
    const c = this.host.camera
    this.host.events.emit('viewport', { zoom: c.zoom, x: c.x, y: c.y })
  }

  /** Re-evaluate hover after the graph moved under a still pointer. */
  get hoveredNode(): number {
    return this.hovered
  }

  get hoveredEdge(): number {
    return this.hoveredEdgeIdx
  }

  destroy(): void {
    for (const d of this.disposers) d()
    this.disposers = []
  }
}
