import { Camera } from './camera'
import { Emitter } from './events'
import { NodeTexture, TEX_WIDTH } from './gl'
import { EdgeIndex, SpatialGrid } from './grid'
import { parallelOffsets } from './curves'
import { Interaction } from './interaction'
import { LabelOverlay } from './labels'
import { EdgeProgram, NodeProgram } from './programs'
import type { BBox, EdgeStyle, EventMap, GraphInput, LabelEntry, NodeStyle, RendererOptions } from './types'

const DEFAULT_NODE_SIZE = 20
const DEFAULT_EDGE_WIDTH = 1.5

/**
 * The renderer. Feed it a graph structure once, then positions whenever they
 * change (typically every simulation tick) and styles when they change.
 * Rendering is on demand: every mutation schedules one frame.
 */
export class Edgelit {
  readonly canvas: HTMLCanvasElement
  readonly gl: WebGL2RenderingContext
  readonly camera = new Camera()
  readonly events = new Emitter<EventMap>()

  private nodeCount = 0
  private edgeCount = 0
  private ends: Uint32Array<ArrayBufferLike> = new Uint32Array(0)
  private offsets: Float32Array<ArrayBuffer> = new Float32Array(0)
  private edgeWidth = new Float32Array(0)
  /** Interleaved xy mirror of the positions, float32. */
  private pos = new Float32Array(0)
  private size = new Float32Array(0)
  private visible = new Uint8Array(0)
  private borderWidth = new Float32Array(0)
  private maxRadius = 0

  private tex: NodeTexture
  private nodes: NodeProgram
  private edges: EdgeProgram
  private grid = new SpatialGrid()
  private edgeIndex = new EdgeIndex()
  private edgeIndexDirty = false
  private parallelSpacing: number
  private labels: LabelOverlay | null = null
  private interaction: Interaction
  private view = new Float32Array(9)

  private texDirty = false
  private gridDirty = false
  private frame = 0
  private dpr: number
  private background: [number, number, number, number]
  private wheelZoomFactor: number
  private resizeObserver: ResizeObserver | null = null
  private destroyed = false
  private lastFrameMs = 0

  constructor(canvas: HTMLCanvasElement, opts: RendererOptions = {}) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: false })
    if (!gl) throw new Error('edgelit: WebGL2 is not available')
    this.gl = gl
    this.dpr = opts.devicePixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1)
    this.background = opts.background ?? [0, 0, 0, 0]
    this.wheelZoomFactor = opts.wheelZoomFactor ?? 1.1
    this.parallelSpacing = opts.parallelSpacing ?? 16
    this.camera.minZoom = opts.minZoom ?? 0.05
    this.camera.maxZoom = opts.maxZoom ?? 20

    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    this.tex = new NodeTexture(gl)
    this.nodes = new NodeProgram(gl)
    this.edges = new EdgeProgram(gl)
    this.interaction = new Interaction({
      canvas,
      camera: this.camera,
      events: this.events,
      pick: (x, y) => this.pick(x, y),
      pickEdge: (x, y) => this.pickEdge(x, y),
      edgeEnds: (e) => [this.ends[2 * e], this.ends[2 * e + 1]],
      requestRender: () => this.requestRender(),
      wheelZoomFactor: this.wheelZoomFactor,
    })

    this.resize()
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize())
      this.resizeObserver.observe(canvas)
    }
  }

  // --- structure & data --------------------------------------------------

  setGraph(g: GraphInput): void {
    const n = g.nodeCount
    this.nodeCount = n
    this.ends = g.edges instanceof Uint32Array ? g.edges : Uint32Array.from(g.edges)
    this.edgeCount = this.ends.length / 2
    for (let i = 0; i < this.ends.length; i++) {
      if (this.ends[i] >= n) throw new Error(`edgelit: edge endpoint ${this.ends[i]} out of range (${n} nodes)`)
    }
    this.offsets = g.curveParallel === false ? new Float32Array(this.edgeCount) : parallelOffsets(this.ends, n, this.parallelSpacing)
    this.edgeWidth = new Float32Array(this.edgeCount).fill(DEFAULT_EDGE_WIDTH)
    this.pos = new Float32Array(2 * n)
    this.size = new Float32Array(n).fill(DEFAULT_NODE_SIZE)
    this.visible = new Uint8Array(n).fill(1)
    this.borderWidth = new Float32Array(n)
    const staging = this.tex.allocate(n)
    staging.fill(0)
    for (let i = 0; i < n; i++) {
      staging[4 * i + 2] = DEFAULT_NODE_SIZE
      staging[4 * i + 3] = 1
    }
    this.maxRadius = DEFAULT_NODE_SIZE / 2
    this.nodes.reset(n, {
      size: this.size,
      color: new Uint8Array(4 * n).fill(180),
      shape: new Uint8Array(n),
      borderWidth: this.borderWidth,
      borderColor: new Uint8Array(4 * n),
      borderDash: new Uint8Array(n),
    })
    this.edges.reset(this.ends, this.offsets, {
      color: new Uint8Array(4 * this.edgeCount).fill(120),
      width: this.edgeWidth,
      arrow: new Uint8Array(this.edgeCount),
      dash: new Uint8Array(this.edgeCount),
    })
    this.texDirty = true
    this.gridDirty = true
    this.edgeIndexDirty = true
    this.requestRender()
  }

  /**
   * The node texture a GPU layout writes positions into directly
   * (`GpuLayout.blitInto`). `rows` is its height in texels.
   */
  get positionTexture(): { tex: WebGLTexture; rows: number } {
    return { tex: this.tex.tex, rows: Math.max(1, Math.ceil(this.nodeCount / TEX_WIDTH)) }
  }

  /**
   * Update ONLY the CPU mirror (picking grid, edge index, labels, staging)
   * from positions that already live on the GPU — no texture upload, so a
   * GPU layout's texture is never overwritten by a stale readback.
   */
  setPositionsMirror(p: ArrayLike<number>): void {
    const n = this.nodeCount
    const s = this.tex.staging
    const pos = this.pos
    for (let i = 0; i < n; i++) {
      const x = p[2 * i], y = p[2 * i + 1]
      pos[2 * i] = x
      pos[2 * i + 1] = y
      s[4 * i] = x
      s[4 * i + 1] = y
    }
    this.gridDirty = true
    this.edgeIndexDirty = true
    this.requestRender()
  }

  /** Interleaved `[x0, y0, x1, y1, …]`; Float64Array (e.g. a wasm view) or Float32Array. */
  setPositions(p: ArrayLike<number>): void {
    const n = this.nodeCount
    const s = this.tex.staging
    const pos = this.pos
    for (let i = 0; i < n; i++) {
      const x = p[2 * i], y = p[2 * i + 1]
      pos[2 * i] = x
      pos[2 * i + 1] = y
      s[4 * i] = x
      s[4 * i + 1] = y
    }
    this.texDirty = true
    this.gridDirty = true
    this.edgeIndexDirty = true
    this.requestRender()
  }

  setNodeStyle(style: NodeStyle): void {
    const n = this.nodeCount
    if (style.size) {
      const s = this.tex.staging
      let mr = 0
      for (let i = 0; i < n; i++) {
        const v = style.size[i]
        this.size[i] = v
        s[4 * i + 2] = v
        if (v > mr) mr = v
      }
      this.maxRadius = mr / 2
      this.texDirty = true
      this.gridDirty = true
    }
    if (style.borderWidth) this.borderWidth.set(style.borderWidth)
    this.nodes.setStyle(style)
    this.requestRender()
  }

  setEdgeStyle(style: EdgeStyle): void {
    if (style.width) this.edgeWidth.set(style.width)
    this.edges.setStyle(style)
    this.requestRender()
  }

  /** 1 = drawn and pickable, 0 = hidden (its edges hide too). */
  setVisibility(v: Uint8Array): void {
    const s = this.tex.staging
    for (let i = 0; i < this.nodeCount; i++) {
      this.visible[i] = v[i]
      s[4 * i + 3] = v[i] ? 1 : 0
    }
    this.texDirty = true
    this.requestRender()
  }

  // --- labels ------------------------------------------------------------

  /** Labels for a subset of nodes, positioned every frame. The canvas's parent must be positioned. */
  setLabels(entries: LabelEntry[]): void {
    if (!this.labels) {
      const host = this.canvas.parentElement
      if (!host) throw new Error('edgelit: canvas needs a parent element for labels')
      this.labels = new LabelOverlay(host)
    }
    this.labels.set(entries)
    this.requestRender()
  }

  // --- camera ------------------------------------------------------------

  /** Bounding box of visible node centres (padded by node radii). */
  bounds(indices?: ArrayLike<number>): BBox | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    const consider = (i: number) => {
      if (!this.visible[i]) return
      const r = this.size[i] / 2 + this.borderWidth[i]
      const x = this.pos[2 * i], y = this.pos[2 * i + 1]
      if (x - r < x0) x0 = x - r
      if (x + r > x1) x1 = x + r
      if (y - r < y0) y0 = y - r
      if (y + r > y1) y1 = y + r
    }
    if (indices) for (let k = 0; k < indices.length; k++) consider(indices[k])
    else for (let i = 0; i < this.nodeCount; i++) consider(i)
    return x0 <= x1 ? { x0, y0, x1, y1 } : null
  }

  /** Fit visible nodes (or the given indices) into view. */
  fit(opts: { indices?: ArrayLike<number>; padding?: number; animate?: number } = {}): void {
    const b = this.bounds(opts.indices)
    if (!b) return
    if (opts.animate) {
      const target = new Camera()
      target.setViewport(this.camera.width, this.camera.height)
      target.minZoom = this.camera.minZoom
      target.maxZoom = this.camera.maxZoom
      target.fit(b, opts.padding ?? 0)
      this.camera.animateTo({ x: target.x, y: target.y, zoom: target.zoom }, opts.animate, performance.now())
    } else {
      this.camera.fit(b, opts.padding ?? 0)
    }
    this.emitViewport()
    this.requestRender()
  }

  /** Set zoom, keeping the viewport centre fixed; optionally animated over `animate` ms. */
  zoomTo(zoom: number, opts: { animate?: number } = {}): void {
    if (opts.animate) this.camera.animateTo({ zoom }, opts.animate, performance.now())
    else this.camera.zoom = this.camera.clampZoom(zoom)
    this.emitViewport()
    this.requestRender()
  }

  centerOn(node: number, opts: { animate?: number } = {}): void {
    const x = this.pos[2 * node], y = this.pos[2 * node + 1]
    if (opts.animate) this.camera.animateTo({ x, y }, opts.animate, performance.now())
    else {
      this.camera.x = x
      this.camera.y = y
    }
    this.emitViewport()
    this.requestRender()
  }

  private emitViewport(): void {
    this.events.emit('viewport', { zoom: this.camera.zoom, x: this.camera.x, y: this.camera.y })
  }

  // --- picking -----------------------------------------------------------

  /** Node under a CSS-pixel point relative to the canvas, or -1. */
  pick(clientX: number, clientY: number): number {
    if (this.gridDirty) this.rebuildGrid()
    const [wx, wy] = this.camera.screenToWorld(clientX, clientY)
    const slack = 2 / this.camera.zoom
    return this.grid.pick(
      this.pos, wx, wy,
      (i) => this.size[i] / 2 + this.borderWidth[i] + slack,
      this.maxRadius + slack + 16,
      (i) => this.visible[i] === 1,
    )
  }

  /** Nodes whose centres fall inside a CSS-pixel rectangle. */
  pickRect(x0: number, y0: number, x1: number, y1: number): number[] {
    if (this.gridDirty) this.rebuildGrid()
    const [ax, ay] = this.camera.screenToWorld(Math.min(x0, x1), Math.min(y0, y1))
    const [bx, by] = this.camera.screenToWorld(Math.max(x0, x1), Math.max(y0, y1))
    return this.grid.queryRect(this.pos, ax, ay, bx, by).filter((i) => this.visible[i] === 1)
  }

  /** Edge under a CSS-pixel point (nodes are not considered), or -1. */
  pickEdge(clientX: number, clientY: number): number {
    if (this.edgeIndexDirty) {
      this.edgeIndex.build(this.pos, this.ends, this.offsets, 128)
      this.edgeIndexDirty = false
    }
    const [wx, wy] = this.camera.screenToWorld(clientX, clientY)
    const slack = 3 / this.camera.zoom
    return this.edgeIndex.pick(
      this.pos, this.ends, this.offsets, wx, wy,
      (e) => this.edgeWidth[e] / 2 + slack,
      (e) => this.visible[this.ends[2 * e]] === 1 && this.visible[this.ends[2 * e + 1]] === 1 && this.ends[2 * e] !== this.ends[2 * e + 1],
    )
  }

  /** Endpoints of an edge. */
  edgeEnds(edge: number): [number, number] {
    return [this.ends[2 * edge], this.ends[2 * edge + 1]]
  }

  /** Per-edge sideways offsets assigned to parallel edges (world units). */
  get edgeOffsets(): Float32Array {
    return this.offsets
  }

  get hoveredNode(): number {
    return this.interaction.hoveredNode
  }

  get hoveredEdge(): number {
    return this.interaction.hoveredEdge
  }

  set nodeDragEnabled(v: boolean) {
    this.interaction.nodeDragEnabled = v
  }

  private rebuildGrid(): void {
    this.grid.build(this.pos, this.nodeCount, Math.max(this.maxRadius * 2, 32))
    this.gridDirty = false
  }

  // --- rendering ---------------------------------------------------------

  resize(): void {
    const w = this.canvas.clientWidth || this.canvas.width
    const h = this.canvas.clientHeight || this.canvas.height
    const bw = Math.max(1, Math.round(w * this.dpr))
    const bh = Math.max(1, Math.round(h * this.dpr))
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw
      this.canvas.height = bh
    }
    this.camera.setViewport(w, h)
    this.requestRender()
  }

  requestRender(): void {
    if (this.frame || this.destroyed) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.render()
    })
  }

  /** Draw a frame now. */
  render(): void {
    if (this.destroyed) return
    const t0 = performance.now()
    const gl = this.gl
    if (this.camera.tick(t0)) this.requestRender()
    if (this.texDirty) {
      this.tex.upload()
      this.texDirty = false
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    const [r, g, b, a] = this.background
    gl.clearColor(r * a, g * a, b * a, a)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const view = this.camera.viewMatrix(this.view)
    const pxPerWorld = this.camera.zoom * this.dpr
    this.edges.draw(view, pxPerWorld, this.tex.tex)
    this.nodes.draw(view, pxPerWorld, this.tex.tex)
    this.labels?.update(this.camera, this.pos, this.size, this.visible)
    this.lastFrameMs = performance.now() - t0
    this.events.emit('render', { frameMs: this.lastFrameMs })
  }

  get stats(): { nodes: number; edges: number; frameMs: number } {
    return { nodes: this.nodeCount, edges: this.edgeCount, frameMs: this.lastFrameMs }
  }

  /** Current positions (float32 mirror), read-only by convention. */
  get positions(): Float32Array {
    return this.pos
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.frame) cancelAnimationFrame(this.frame)
    this.resizeObserver?.disconnect()
    this.interaction.destroy()
    this.labels?.destroy()
    this.nodes.destroy()
    this.edges.destroy()
    this.tex.destroy()
    this.events.clear()
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
