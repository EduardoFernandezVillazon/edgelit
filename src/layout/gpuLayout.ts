// GPU force layout: the whole simulation as WebGL2 passes over RGBA32F
// textures. Mirrors the command surface of forcefield-sim's worker host so a
// consuming app (nemo-graph's SimHost) can drive either. Design and the
// reference it ports: nemo-graph docs/architecture/cosmos-review.md.
import { createProgram, TEX_WIDTH as W } from '../gl'
import { VS_QUAD, VS_SPLAT, FS_SPLAT, VS_SLOT, FS_SLOT, FS_BLIT, FS_VEL, FS_POS } from './shaders'

export interface LayoutNode { id?: string | number; x?: number; y?: number; fx?: number | null; fy?: number | null }
export interface LayoutLink { source: number; target: number; distance?: number; strength?: number }
export interface LayoutPayload {
  forces?: { centerForce?: number; repelForce?: number; linkForce?: number; linkDistance?: number }
  /** Per-node centre strength (depth centring); overrides forces.centerForce per node. */
  centreStrength?: ArrayLike<number> | null
  /** Per-node collide radius; default collideRadius. */
  radius?: ArrayLike<number> | null
  collideRadius?: number
  collideStrength?: number
  /** [[leftIndex, rightIndex], …] — left is pushed left of right by dagGap. */
  dagPairs?: Array<[number, number]> | null
  dag?: { gap: number; strength: number }
  adaptive?: { adaptiveCooling: boolean; alphaDecay: number; movementThreshold?: number } | null
  velocityDecay?: number
  manyBodyDistanceMin?: number
  manyBodyDistanceMax?: number
}
export interface GpuLayoutOptions {
  /** Number of many-body levels (finest first). Default 6. */
  levels?: number
  /** Finest grid cells per axis. Default 256. */
  finestGrid?: number
  /** Near-field samples per finest cell. Default 8 (max 8). */
  slots?: number
  /** Ticks between asynchronous readbacks. Default 6. */
  readbackEvery?: number
  /** Max adjacency entries applied per node per tick (hubs beyond are truncated on their side). Default 64. */
  maxDegree?: number
}

type Target = { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number }
type Listener = (...a: any[]) => void

const DEFAULT_FORCES = { centerForce: 0.05, repelForce: 150, linkForce: 0.3, linkDistance: 80 }

export class GpuLayout {
  readonly gl: WebGL2RenderingContext
  n = 0
  rows = 1
  space = 1000
  ticks = 0
  private _alpha = 1
  private _alphaMin = 0.001
  private _alphaDecay = 0.015
  private _alphaTarget = 0
  private _running = false
  private pos: [Target, Target] | null = null
  private vel: [Target, Target] | null = null
  private attr: Target | null = null
  private adjOff: Target | null = null
  private adj: Target | null = null
  private levels: Target[] = []
  private slots: Target[] = []
  private depthRb: WebGLRenderbuffer | null = null
  private pSplat: WebGLProgram; private pSlot: WebGLProgram; private pVel: WebGLProgram; private pPos: WebGLProgram; private pBlit: WebGLProgram
  private payload: LayoutPayload = {}
  private nodes: LayoutNode[] = []
  private links: LayoutLink[] = []
  private latest: Float32Array | null = null     // last readback, [x0,y0,x1,y1,…]
  private staging: Float32Array = new Float32Array(0)
  private pbo: WebGLBuffer | null = null            // one pixel-pack buffer per init, reused by every readback
  private pending: { sync: WebGLSync; startTick: number } | null = null
  private cooling: { prev: Float32Array | null; prevTick: number; window: number[]; tickCount: number } | null = null
  private listeners = new Map<string, Set<Listener>>()
  private blitFbs = new WeakMap<WebGLTexture, WebGLFramebuffer>()
  readonly opts: Required<GpuLayoutOptions>
  readonly ext: { colorBufferFloat: boolean; floatBlend: boolean }

  constructor(gl: WebGL2RenderingContext, opts: GpuLayoutOptions = {}) {
    this.gl = gl
    this.opts = { levels: opts.levels ?? 6, finestGrid: opts.finestGrid ?? 256, slots: Math.min(8, opts.slots ?? 8), readbackEvery: opts.readbackEvery ?? 6, maxDegree: opts.maxDegree ?? 64 }
    this.ext = { colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'), floatBlend: !!gl.getExtension('EXT_float_blend') }
    if (!this.ext.colorBufferFloat) throw new Error('GpuLayout: EXT_color_buffer_float is required (render to float textures)')
    if (!this.ext.floatBlend) throw new Error('GpuLayout: EXT_float_blend is required (additive float blending for the level grids)')
    this.pSplat = createProgram(gl, VS_SPLAT, FS_SPLAT)
    this.pSlot = createProgram(gl, VS_SLOT, FS_SLOT)
    this.pVel = createProgram(gl, VS_QUAD, FS_VEL)
    this.pPos = createProgram(gl, VS_QUAD, FS_POS)
    this.pBlit = createProgram(gl, VS_QUAD, FS_BLIT)
  }

  // ---- events (d3-dispatch shape: 'tick', 'end', 'readback'; namespaces allowed)
  on(type: string, fn: Listener | null): this {
    const base = type.split('.')[0]
    let set = this.listeners.get(base)
    if (!set) { set = new Set(); this.listeners.set(base, set) }
    ;(fn as any).__ns = type
    for (const f of set) if ((f as any).__ns === type) set.delete(f)
    if (fn) set.add(fn)
    return this
  }
  private emit(type: string, ...a: any[]) { this.listeners.get(type)?.forEach((f) => f(...a)) }

  // ---- targets
  private target(w: number, h: number, data: Float32Array | null): Target {
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data)
    const fb = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('GpuLayout: float framebuffer incomplete ' + st)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { tex, fb, w, h }
  }
  private freeTarget(t: Target | null) { if (!t) return; this.gl.deleteTexture(t.tex); this.gl.deleteFramebuffer(t.fb) }
  private freeAll() {
    for (const t of [...(this.pos ?? []), ...(this.vel ?? []), this.attr, this.adjOff, this.adj, ...this.levels, ...this.slots]) this.freeTarget(t)
    this.pos = this.vel = null; this.attr = this.adjOff = this.adj = null; this.levels = []; this.slots = []
    if (this.depthRb) { this.gl.deleteRenderbuffer(this.depthRb); this.depthRb = null }
  }

  // ---- lifecycle
  /**
   * (Re)create the simulation. With `keepPositions`, nodes whose id existed
   * keep position, velocity and pins from the last readback/state.
   */
  init({ nodes, links = [], payload = {}, keepPositions = false, running = true }: { nodes: LayoutNode[]; links?: LayoutLink[]; payload?: LayoutPayload; keepPositions?: boolean; running?: boolean }): void {
    const gl = this.gl
    const prevById = new Map<string | number, { x: number; y: number; vx: number; vy: number; fx: number | null; fy: number | null }>()
    if (keepPositions && this.nodes.length && this.latest) {
      const velRb = this.readVelocitiesSync()
      const pinRb = this.readPositionsSync()
      this.nodes.forEach((nd, i) => {
        if (nd.id == null) return
        prevById.set(nd.id, { x: pinRb[4 * i], y: pinRb[4 * i + 1], vx: velRb[4 * i], vy: velRb[4 * i + 1], fx: pinRb[4 * i + 3] > 0.5 ? pinRb[4 * i] : null, fy: pinRb[4 * i + 3] > 0.5 ? pinRb[4 * i + 1] : null })
      })
    }
    this.freeAll()
    this.nodes = nodes; this.links = links; this.payload = payload
    const n = nodes.length
    this.n = n; this.rows = Math.max(1, Math.ceil(n / W)); this.ticks = 0
    const pos = new Float32Array(W * this.rows * 4)
    const vel = new Float32Array(W * this.rows * 4)
    let extent = 1
    // d3's initial placement for unset positions: a phyllotaxis spiral
    const initialRadius = 10, initialAngle = Math.PI * (3 - Math.sqrt(5))
    nodes.forEach((nd, i) => {
      const prev = nd.id != null ? prevById.get(nd.id) : undefined
      let x = nd.x ?? prev?.x, y = nd.y ?? prev?.y
      if (x == null || y == null) { const r = initialRadius * Math.sqrt(0.5 + i), a = i * initialAngle; x = r * Math.cos(a); y = r * Math.sin(a) }
      const fx = nd.fx ?? prev?.fx ?? null, fy = nd.fy ?? prev?.fy ?? null
      const fixed = fx != null && fy != null
      pos[4 * i] = fixed ? fx! : x; pos[4 * i + 1] = fixed ? fy! : y; pos[4 * i + 2] = 1; pos[4 * i + 3] = fixed ? 1 : 0
      vel[4 * i] = prev?.vx ?? 0; vel[4 * i + 1] = prev?.vy ?? 0
      extent = Math.max(extent, Math.abs(pos[4 * i]), Math.abs(pos[4 * i + 1]))
    })
    for (let i = n; i < W * this.rows; i++) pos[4 * i + 2] = -1   // absent texels
    this.space = Math.max(extent * 1.5, Math.sqrt(n) * 60, 500)
    this.pos = [this.target(W, this.rows, pos), this.target(W, this.rows, pos)]
    this.vel = [this.target(W, this.rows, vel), this.target(W, this.rows, vel)]
    this.staging = new Float32Array(W * this.rows * 4)
    if (this.pbo) gl.deleteBuffer(this.pbo)
    this.pbo = gl.createBuffer()!
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo)
    gl.bufferData(gl.PIXEL_PACK_BUFFER, this.staging.byteLength, gl.STREAM_READ)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    this.latest = new Float32Array(2 * n)
    for (let i = 0; i < n; i++) { this.latest[2 * i] = pos[4 * i]; this.latest[2 * i + 1] = pos[4 * i + 1] }
    this.levels = []
    for (let l = 0; l < this.opts.levels; l++) { const G = Math.max(2, this.opts.finestGrid >> l); this.levels.push(this.target(G, G, null)) }
    const G0 = this.levels[0].w
    this.slots = []
    for (let k = 0; k < this.opts.slots; k++) this.slots.push(this.target(G0, G0, null))
    const rb = gl.createRenderbuffer()!; gl.bindRenderbuffer(gl.RENDERBUFFER, rb)
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, G0, G0)
    this.depthRb = rb
    for (const s of this.slots) { gl.bindFramebuffer(gl.FRAMEBUFFER, s.fb); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb) }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.setup(payload)
    this._alpha = 1; this._alphaTarget = 0
    this._running = running
    this.cooling = null
    this.applyCooling()
    if (this.pending) { gl.deleteSync(this.pending.sync); this.pending = null }
  }

  /** Re-derive the force textures from a new payload on the live simulation. */
  setup(payload: LayoutPayload): void {
    this.payload = payload
    const n = this.n
    const f = { ...DEFAULT_FORCES, ...(payload.forces ?? {}) }
    const attr = new Float32Array(W * this.rows * 4)
    const cr = payload.collideRadius ?? 25
    for (let i = 0; i < n; i++) {
      attr[4 * i] = payload.centreStrength ? payload.centreStrength[i] : f.centerForce
      attr[4 * i + 1] = payload.radius ? payload.radius[i] : cr
    }
    // CSR adjacency: links both ways (each side applies half), DAG pairs typed
    const deg = new Uint32Array(n)
    for (const l of this.links) { deg[l.source]++; deg[l.target]++ }
    const lists: number[][] = Array.from({ length: n }, () => [])
    for (const l of this.links) {
      const minDeg = Math.max(1, Math.min(deg[l.source], deg[l.target]))
      const strength = l.strength ?? f.linkForce / minDeg
      const dist = l.distance ?? f.linkDistance
      lists[l.source].push(l.target, dist, strength, 0)
      lists[l.target].push(l.source, dist, strength, 0)
    }
    for (const [left, right] of payload.dagPairs ?? []) { lists[left].push(right, 0, 0, 1); lists[right].push(left, 0, 0, 2) }
    let total = 0; for (const li of lists) total += li.length / 4
    const adjRows = Math.max(1, Math.ceil(total / W))
    const adj = new Float32Array(W * adjRows * 4)
    const off = new Float32Array(W * this.rows * 4)
    let k = 0
    for (let i = 0; i < n; i++) { off[4 * i] = k; off[4 * i + 1] = lists[i].length / 4; adj.set(lists[i], 4 * k); k += lists[i].length / 4 }
    this.freeTarget(this.attr); this.freeTarget(this.adjOff); this.freeTarget(this.adj)
    this.attr = this.target(W, this.rows, attr)
    this.adjOff = this.target(W, this.rows, off)
    this.adj = this.target(W, adjRows, adj)
    this._alphaDecay = payload.adaptive?.alphaDecay ?? 0.015
    this.applyCooling()
  }

  // ---- parameters (d3 shape)
  alpha(v?: number): any { if (v === undefined) return this._alpha; this._alpha = v; return this }
  alphaMin(v?: number): any { if (v === undefined) return this._alphaMin; this._alphaMin = v; return this }
  alphaDecay(v?: number): any { if (v === undefined) return this._alphaDecay; this._alphaDecay = v; return this }
  alphaTarget(v?: number): any { if (v === undefined) return this._alphaTarget; this._alphaTarget = v; if (v > 0) this._running = true; return this }
  run(running: boolean): this { this._running = running; return this }
  restart(): this { return this.run(true) }
  stop(): this { return this.run(false) }
  get running(): boolean { return this._running }

  setFixed(i: number, x: number, y: number): void {
    if (!this.pos || i < 0 || i >= this.n) return
    const free = Number.isNaN(x) || Number.isNaN(y)
    const cur = free ? [this.latest![2 * i], this.latest![2 * i + 1]] : [x, y]
    this.poke(this.pos[0], i, new Float32Array([cur[0], cur[1], 1, free ? 0 : 1]))
    this.poke(this.pos[1], i, new Float32Array([cur[0], cur[1], 1, free ? 0 : 1]))
    if (!free) { this.latest![2 * i] = x; this.latest![2 * i + 1] = y }
  }
  setPosition(i: number, x: number, y: number): void {
    if (!this.pos || i < 0 || i >= this.n) return
    const fixed = this.staging[4 * i + 3]
    this.poke(this.pos[0], i, new Float32Array([x, y, 1, fixed])); this.poke(this.pos[1], i, new Float32Array([x, y, 1, fixed]))
    this.poke(this.vel![0], i, new Float32Array(4)); this.poke(this.vel![1], i, new Float32Array(4))
    this.latest![2 * i] = x; this.latest![2 * i + 1] = y
  }
  private poke(t: Target, i: number, texel: Float32Array) {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, t.tex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, i % W, Math.floor(i / W), 1, 1, gl.RGBA, gl.FLOAT, texel)
  }

  // ---- the tick
  private bind(unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) {
    const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(loc, unit)
  }
  tick(iterations = 1): this {
    for (let it = 0; it < iterations; it++) this.tickOnce()
    return this
  }
  private tickOnce() {
    const gl = this.gl
    if (!this.pos || !this.vel || !this.attr || !this.adjOff || !this.adj) return
    const p = this.payload, f = { ...DEFAULT_FORCES, ...(p.forces ?? {}) }
    this._alpha += (this._alphaTarget - this._alpha) * this._alphaDecay
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true)
    // 1. level grids
    gl.useProgram(this.pSplat)
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE)
    const uS = (name: string) => gl.getUniformLocation(this.pSplat, name)
    this.bind(0, this.pos[0].tex, uS('u_pos')); gl.uniform1f(uS('u_space'), this.space); gl.uniform1i(uS('u_n'), this.n)
    for (const lvl of this.levels) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, lvl.fb); gl.viewport(0, 0, lvl.w, lvl.h)
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform1f(uS('u_grid'), lvl.w)
      gl.drawArrays(gl.POINTS, 0, this.n)
    }
    gl.disable(gl.BLEND)
    // 2. near-field slots by depth peeling
    gl.useProgram(this.pSlot)
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS)
    const uL = (name: string) => gl.getUniformLocation(this.pSlot, name)
    this.bind(0, this.pos[0].tex, uL('u_pos')); gl.uniform1f(uL('u_space'), this.space); gl.uniform1i(uL('u_n'), this.n)
    gl.uniform1f(uL('u_grid'), this.levels[0].w); gl.uniform1f(uL('u_seed'), (this.ticks % 1000) / 1000)
    this.slots.forEach((s, k) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fb); gl.viewport(0, 0, s.w, s.h)
      gl.clearColor(-1, 2, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.uniform1i(uL('u_hasPrev'), k > 0 ? 1 : 0)
      // pass 0 reads no previous slot; binding its own target would be a feedback loop
      this.bind(1, (k > 0 ? this.slots[k - 1] : this.levels[0]).tex, uL('u_prev'))
      gl.drawArrays(gl.POINTS, 0, this.n)
    })
    gl.disable(gl.DEPTH_TEST)
    // 3. velocities
    gl.useProgram(this.pVel)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.vel[1].fb); gl.viewport(0, 0, W, this.rows)
    const u = (name: string) => gl.getUniformLocation(this.pVel, name)
    this.bind(0, this.pos[0].tex, u('u_pos')); this.bind(1, this.vel[0].tex, u('u_vel')); this.bind(2, this.attr.tex, u('u_attr'))
    this.bind(3, this.adjOff.tex, u('u_adjOff')); this.bind(4, this.adj.tex, u('u_adj'))
    let unit = 5
    this.levels.forEach((lvl, l) => { this.bind(unit++, lvl.tex, u(`u_level[${l}]`)); gl.uniform1f(u(`u_grid[${l}]`), lvl.w) })
    for (let l = this.levels.length; l < 8; l++) { this.bind(unit++, this.levels[0].tex, u(`u_level[${l}]`)); gl.uniform1f(u(`u_grid[${l}]`), 1) }
    this.slots.forEach((s, k) => this.bind(unit++, s.tex, u(`u_slot[${k}]`)))
    for (let k = this.slots.length; k < 8; k++) this.bind(unit++, this.slots[0].tex, u(`u_slot[${k}]`))
    gl.uniform1i(u('u_n'), this.n); gl.uniform1i(u('u_levels'), this.levels.length); gl.uniform1i(u('u_slots'), this.slots.length); gl.uniform1i(u('u_maxDeg'), this.opts.maxDegree)
    gl.uniform1f(u('u_alpha'), this._alpha); gl.uniform1f(u('u_space'), this.space)
    gl.uniform1f(u('u_repel'), f.repelForce / Math.max(Math.log(this.n + 1), 0.01))
    const dmin = p.manyBodyDistanceMin ?? 5, dmax = p.manyBodyDistanceMax ?? 250
    gl.uniform1f(u('u_distMin2'), dmin * dmin); gl.uniform1f(u('u_distMax2'), dmax * dmax)
    gl.uniform1f(u('u_collideR'), p.collideRadius ?? 25); gl.uniform1f(u('u_collideStrength'), p.collideStrength ?? 1)
    gl.uniform1f(u('u_dagGap'), p.dag?.gap ?? 120); gl.uniform1f(u('u_dagStrength'), p.dag?.strength ?? 0.1)
    gl.uniform1f(u('u_decay'), 1 - (p.velocityDecay ?? 0.35))
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    // 4. positions
    gl.useProgram(this.pPos)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pos[1].fb); gl.viewport(0, 0, W, this.rows)
    this.bind(0, this.pos[0].tex, gl.getUniformLocation(this.pPos, 'u_pos')); this.bind(1, this.vel[1].tex, gl.getUniformLocation(this.pPos, 'u_vel'))
    gl.uniform1f(gl.getUniformLocation(this.pPos, 'u_space'), this.space)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.pos.reverse(); this.vel.reverse()
    this.ticks++
    // 5. readback cadence + cooling + end
    this.pollReadback()
    if (this.ticks % this.opts.readbackEvery === 0 && !this.pending) this.startReadback()
    if (this.cooling && this.ticks >= Math.max(300, this.n * 10) && this.payload.adaptive) this._alphaDecay = this.payload.adaptive.alphaDecay
    this.emit('tick', this)
    if (this._alpha < this._alphaMin) { this._running = false; this.emit('end', this) }
  }

  /** Step the simulation if running; call once per animation frame. Returns whether it ticked. */
  step(): boolean { if (!this._running) { this.pollReadback(); return false } this.tickOnce(); return true }

  // ---- readback (async via PBO + fence; sync helpers for init/tests)
  private startReadback() {
    const gl = this.gl
    if (!this.pos) return
    if (!this.pbo) return
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pos[0].fb)
    gl.readPixels(0, 0, W, this.rows, gl.RGBA, gl.FLOAT, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!
    gl.flush()
    this.pending = { sync, startTick: this.ticks }
  }
  private pollReadback() {
    const gl = this.gl
    const pd = this.pending
    if (!pd) return
    const st = gl.clientWaitSync(pd.sync, 0, 0)
    if (st === gl.TIMEOUT_EXPIRED || st === gl.WAIT_FAILED) { if (st === gl.WAIT_FAILED) this.dropPending(); return }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo)
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.staging)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    this.dropPending()
    this.absorb(pd.startTick)
  }
  private dropPending() { const gl = this.gl; if (!this.pending) return; gl.deleteSync(this.pending.sync); this.pending = null }
  private absorb(atTick: number) {
    const n = this.n, s = this.staging, out = this.latest!
    let extent = 0
    for (let i = 0; i < n; i++) { const x = s[4 * i], y = s[4 * i + 1]; out[2 * i] = x; out[2 * i + 1] = y; const e = Math.max(Math.abs(x), Math.abs(y)); if (e > extent) extent = e }
    if (extent > this.space * 0.9) this.space = extent * 1.5   // let the grid grow with the layout
    this.coolingSample(atTick)
    this.emit('readback', out, { tick: atTick })
  }
  readPositionsSync(): Float32Array { const gl = this.gl; const out = new Float32Array(W * this.rows * 4); if (!this.pos) return out; gl.bindFramebuffer(gl.FRAMEBUFFER, this.pos[0].fb); gl.readPixels(0, 0, W, this.rows, gl.RGBA, gl.FLOAT, out); gl.bindFramebuffer(gl.FRAMEBUFFER, null); return out }
  private readVelocitiesSync(): Float32Array { const gl = this.gl; const out = new Float32Array(W * this.rows * 4); if (!this.vel) return out; gl.bindFramebuffer(gl.FRAMEBUFFER, this.vel[0].fb); gl.readPixels(0, 0, W, this.rows, gl.RGBA, gl.FLOAT, out); gl.bindFramebuffer(gl.FRAMEBUFFER, null); return out }
  /** Latest positions on the CPU (from the last readback), `[x0, y0, x1, y1, …]`. */
  get positions(): Float32Array { return this.latest ?? new Float32Array(0) }
  /** Force a synchronous readback now (tests; the interim cytoscape path). */
  readbackNow(): Float32Array { const s = this.readPositionsSync(); this.staging.set(s); this.absorb(this.ticks); return this.latest! }

  // ---- adaptive cooling (nemo's controller, fed by readbacks instead of every tick)
  private applyCooling() {
    const a = this.payload.adaptive
    if (!a || !a.adaptiveCooling) { this._alphaDecay = a?.alphaDecay ?? this._alphaDecay; this.cooling = null; return }
    this._alphaMin = this.n > 200 ? 0.0005 : 0.001
    this._alphaDecay = 0   // freeze the clock until movement settles
    this.cooling = { prev: null, prevTick: this.ticks, window: [], tickCount: 0 }
  }
  private coolingSample(atTick: number) {
    const c = this.cooling, a = this.payload.adaptive
    if (!c || !a) return
    const base = a.alphaDecay, threshold = (a.movementThreshold ?? 0.5) * Math.max(1, Math.log10(Math.max(this.n, 2)))
    const maxTicks = Math.max(300, this.n * 10)
    c.tickCount = atTick
    if (c.tickCount >= maxTicks) { this._alphaDecay = base; return }
    if (c.prev && atTick <= c.prevTick) return
    const cur = this.latest!
    if (c.prev && atTick > c.prevTick) {
      let sum = 0
      for (let i = 0; i < 2 * this.n; i += 2) { const dx = cur[i] - c.prev[i], dy = cur[i + 1] - c.prev[i + 1]; sum += dx * dx + dy * dy }
      const perTick = sum / Math.max(1, this.n) / (atTick - c.prevTick)   // MSD per tick, squared displacement scales with ticks²/ticks ≈ ticks
      c.window.push(perTick / (atTick - c.prevTick))
      if (c.window.length > 5) c.window.shift()
      if (c.window.length === 5) { const avg = c.window.reduce((x, y) => x + y, 0) / 5; this._alphaDecay = avg > threshold ? 0 : base }
    }
    if (!c.prev || c.prev.length !== cur.length) c.prev = new Float32Array(cur.length)
    c.prev.set(cur); c.prevTick = atTick
  }

  // ---- renderer coupling
  /** Write x, y into an RGBA32F node texture of the same layout (edgelit's), leaving z, w untouched. */
  blitInto(tex: WebGLTexture, rows: number): void {
    const gl = this.gl
    if (!this.pos) return
    let fb = this.blitFbs.get(tex)
    if (!fb) { fb = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0); this.blitFbs.set(tex, fb) }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, W, Math.min(rows, this.rows))
    gl.colorMask(true, true, false, false)
    gl.useProgram(this.pBlit)
    this.bind(0, this.pos[0].tex, gl.getUniformLocation(this.pBlit, 'u_pos'))
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.colorMask(true, true, true, true)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  free(): void { this.dropPending(); this.freeAll(); if (this.pbo) { this.gl.deleteBuffer(this.pbo); this.pbo = null } this.n = 0 }
}
