// GPU layout demo + WebKitGTK test harness: GpuLayout writes straight into the
// renderer's node texture each frame; the 10 Hz readback refreshes picking.
import { Edgelit, GpuLayout, Shape } from 'edgelit'

const canvas = document.getElementById('c') as HTMLCanvasElement
const r = new Edgelit(canvas, { background: [0.086, 0.09, 0.114, 1] })
const gl = r.gl
const layout = new GpuLayout(gl, {})
let world: { n: number; ends: Uint32Array; degree: Uint32Array; ticks: number } | null = null
const hud = document.getElementById('hud')!

/** nemo-like graph: a tree (folders with fan-out) plus random links; hubs exist. */
export function buildGraph(n: number, seed = 1) {
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32
  const src: number[] = [], tgt: number[] = []
  for (let i = 1; i < n; i++) { const parent = Math.floor(rnd() * Math.min(i, Math.max(1, i / 8 + 1))); src.push(parent); tgt.push(i) }
  for (let k = 0; k < n / 4; k++) { const a = Math.floor(rnd() * n), b = Math.floor(rnd() * n); if (a !== b) { src.push(a); tgt.push(b) } }
  return { src, tgt }
}

export function build(n: number, opts: { dagPairs?: Array<[number, number]>; pins?: Array<[number, number, number]>; adaptive?: boolean; links?: { src: number[]; tgt: number[] }; noCentre?: boolean } = {}) {
  const t0 = performance.now()
  const { src, tgt } = opts.links ?? buildGraph(n)
  const m = src.length
  const ends = new Uint32Array(2 * m), degree = new Uint32Array(n)
  for (let i = 0; i < m; i++) { ends[2 * i] = src[i]; ends[2 * i + 1] = tgt[i]; degree[src[i]]++; degree[tgt[i]]++ }
  r.setGraph({ nodeCount: n, edges: ends })
  const size = new Float32Array(n), color = new Uint8Array(4 * n), shape = new Uint8Array(n)
  for (let i = 0; i < n; i++) { const hub = degree[i] >= 8; size[i] = hub ? 36 : 22; shape[i] = i === 0 ? Shape.diamond : Shape.circle; color.set(hub ? [170, 59, 255, 255] : [110, 120, 150, 255], 4 * i) }
  r.setNodeStyle({ size, color, shape })
  const ec = new Uint8Array(4 * m), ew = new Float32Array(m), ea = new Uint8Array(m), ed = new Uint8Array(m)
  for (let i = 0; i < m; i++) { ec.set([90, 96, 120, 160], 4 * i); ew[i] = 1 }
  r.setEdgeStyle({ color: ec, width: ew, arrow: ea, dash: ed })
  const nodes = Array.from({ length: n }, (_, i) => ({ id: i }) as any)
  for (const [i, x, y] of opts.pins ?? []) { nodes[i].fx = x; nodes[i].fy = y }
  const links = src.map((s2, i) => ({ source: s2, target: tgt[i] }))
  const depth = new Float32Array(n)   // depth from the tree root: strength 5x, 3x, 1.5x, 1x like nemo
  for (let i = 1; i < n - 1 && i < src.length; i++) depth[tgt[i]] = depth[src[i]] + 1
  const centre = opts.noCentre ? new Float32Array(n) : Float32Array.from(depth, (d) => 0.05 * (d === 0 ? 5 : d === 1 ? 3 : d === 2 ? 1.5 : 1))
  layout.init({ nodes, links, payload: { centreStrength: centre, radius: Float32Array.from(size, (v) => v / 2 + 4), dagPairs: opts.dagPairs ?? null, adaptive: { adaptiveCooling: opts.adaptive ?? true, alphaDecay: 0.015, movementThreshold: 0.5 } } })
  r.setPositions(layout.positions)
  r.fit({ padding: 40 })
  world = { n, ends, degree, ticks: 0 }
  ;(window as any).__lastBuildMs = performance.now() - t0
  return world
}

let paused = false
let frameMs = 0
layout.on('readback', (pos: Float32Array) => { r.setPositionsMirror(pos) })
function frame() {
  if (world && !paused) {
    const t = performance.now()
    const s0 = performance.now()
    const ticked = layout.step()
    const s1 = performance.now()
    if (ticked) { const { tex, rows } = r.positionTexture; layout.blitInto(tex, rows); r.requestRender(); world.ticks++ }
    const w = window as any; w.__stepMax = Math.max(w.__stepMax ?? 0, s1 - s0); w.__blitMax = Math.max(w.__blitMax ?? 0, performance.now() - s1)
    frameMs = frameMs * 0.9 + (performance.now() - t) * 0.1
  }
  if (world) hud.textContent = `n=${world.n}  ticks=${layout.ticks}  alpha=${layout.alpha().toFixed(3)}  decay=${layout.alphaDecay()}  running=${layout.running}  cpu ms/frame=${frameMs.toFixed(2)}  draw=${r.stats.frameMs.toFixed(2)}`
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
document.getElementById('n')!.addEventListener('change', (e) => build(+(e.target as HTMLSelectElement).value))
document.getElementById('fit')!.addEventListener('click', () => r.fit({ padding: 40, animate: 300 }))
document.getElementById('toggle')!.addEventListener('click', () => { paused = !paused })
r.events.on('dragstart', () => layout.alphaTarget(0.3))
r.events.on('drag', ({ node, x, y }: any) => layout.setFixed(node, x, y))
r.events.on('dragend', () => layout.alphaTarget(0))
build(14000)
;(window as any).gpulayout = { r, layout, build, buildGraph, world: () => world, setPaused: (v: boolean) => { paused = v } }
