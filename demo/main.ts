// Demo and browser-test harness: forcefield (wasm) drives the simulation,
// edgelit draws it. Exposes `window.demo` for the Playwright tests.
import init, { Simulation } from 'forcefield-wasm'
import type { Cmd, Frame } from './simWorker'
import { Arrow, Dash, Edgelit, Shape } from 'edgelit'

await init()

const canvas = document.getElementById('c') as HTMLCanvasElement
const hud = document.getElementById('hud')!
const r = new Edgelit(canvas, { background: [0.086, 0.09, 0.114, 1] })

function lcg(seed = 1) {
  let s = seed
  return () => (s = (1664525 * s + 1013904223) % 4294967296) / 4294967296
}

interface World {
  n: number
  sim: Simulation
  ends: Uint32Array
  degree: Uint32Array
  running: boolean
  ticks: number
}
let world: World | null = null

// --- worker mode ---------------------------------------------------------
let worker: Worker | null = null
let workerMode = false
let workerStats = { tick: 0, alpha: 1, simMs: 0, framesReceived: 0, lastFrameAt: 0, fps: 0 }
function startWorker(n: number, positions: Float64Array, src: number[], tgt: number[], strength: number[]) {
  worker?.terminate()
  worker = new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<Frame>) => {
    const f = e.data
    if (f.type !== 'frame') return
    const pos = new Float32Array(f.buf)
    r.setPositions(pos)                     // one O(n) copy into the texture staging
    worker!.postMessage({ type: 'buffer', buf: f.buf } as Cmd, [f.buf])
    const now = performance.now()
    workerStats.fps = workerStats.lastFrameAt ? workerStats.fps * 0.9 + (1000 / (now - workerStats.lastFrameAt)) * 0.1 : 0
    workerStats.lastFrameAt = now
    workerStats.tick = f.tick; workerStats.alpha = f.alpha; workerStats.simMs = workerStats.simMs * 0.9 + f.simMs * 0.1; workerStats.framesReceived++
  }
  const msg: Cmd = { type: 'init', n, positions, src: Uint32Array.from(src), tgt: Uint32Array.from(tgt), strength: Float64Array.from(strength), bufferCount: 3 }
  worker.postMessage(msg, [msg.positions.buffer, msg.src.buffer, msg.tgt.buffer, msg.strength.buffer])
}

function build(n: number): World {
  world?.sim.free()
  const rnd = lcg(7)
  const pos = new Float64Array(2 * n)
  for (let i = 0; i < n; i++) {
    pos[2 * i] = (rnd() - 0.5) * Math.sqrt(n) * 40
    pos[2 * i + 1] = (rnd() - 0.5) * Math.sqrt(n) * 30
  }
  const src: number[] = [], tgt: number[] = []
  for (let i = 1; i < n; i++) { src.push(Math.floor(rnd() * i)); tgt.push(i) }
  for (let k = 0; k < n / 4; k++) {
    const a = Math.floor(rnd() * n), b = Math.floor(rnd() * n)
    if (a !== b) { src.push(a); tgt.push(b) }
  }
  // bidirectional pairs (every 6th extra edge gets its reverse) and a triple
  const extraStart = n - 1
  for (let i = extraStart; i < src.length; i += 6) { src.push(tgt[i]); tgt.push(src[i]) }
  src.push(src[extraStart], src[extraStart]); tgt.push(tgt[extraStart], tgt[extraStart])
  const m = src.length
  const ends = new Uint32Array(2 * m)
  const degree = new Uint32Array(n)
  for (let i = 0; i < m; i++) { ends[2 * i] = src[i]; ends[2 * i + 1] = tgt[i]; degree[src[i]]++; degree[tgt[i]]++ }

  if (workerMode) startWorker(n, Float64Array.from(pos), src.slice(), tgt.slice(), src.map((s, i) => 0.3 / Math.max(1, Math.min(degree[s], degree[tgt[i]]))))
  const sim = Simulation.fromPositions(pos)
  sim.setAlphaDecay(0.015); sim.setVelocityDecay(0.35)
  const strength = src.map((s, i) => 0.3 / Math.max(1, Math.min(degree[s], degree[tgt[i]])))
  sim.forceCollide('collide', Float64Array.of(25), 1, 2)
  sim.forceLink('link', Uint32Array.from(src), Uint32Array.from(tgt), Float64Array.of(80), Float64Array.from(strength), 1)
  sim.forceManyBody('many-body', Float64Array.of(-150), 0.9, 5, 250)
  sim.forceX('x', Float64Array.of(0), Float64Array.of(0.05)); sim.forceY('y', Float64Array.of(0), Float64Array.of(0.05))

  r.setGraph({ nodeCount: n, edges: ends })
  // styles: hubs bigger and gold, tag-like every 7th as green hexagons, dirs as squares
  const size = new Float32Array(n), color = new Uint8Array(4 * n), shape = new Uint8Array(n)
  const bw = new Float32Array(n), bc = new Uint8Array(4 * n), bd = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const hub = degree[i] >= 8
    size[i] = hub ? 44 : i % 7 === 0 ? 28 : 34
    shape[i] = i === 0 ? Shape.diamond : i % 7 === 0 ? Shape.hexagon : i % 5 === 0 ? Shape.rect : Shape.circle
    const c = i === 0 ? [255, 209, 102] : i % 7 === 0 ? [63, 178, 127] : hub ? [170, 59, 255] : [110, 120, 150]
    color.set([c[0], c[1], c[2], 255], 4 * i)
    if (i % 11 === 0) { bw[i] = 3; bc.set([74, 158, 255, 255], 4 * i); bd[i] = i % 22 === 0 ? Dash.dashed : Dash.solid }
  }
  r.setNodeStyle({ size, color, shape, borderWidth: bw, borderColor: bc, borderDash: bd })
  const ec = new Uint8Array(4 * m), ew = new Float32Array(m), ea = new Uint8Array(m), ed = new Uint8Array(m)
  baseEdgeStyle = { color: ec, width: ew, arrow: ea, dash: ed }
  for (let i = 0; i < m; i++) {
    ec.set(i < n - 1 ? [90, 96, 120, 200] : [170, 59, 255, 220], 4 * i)
    ew[i] = i < n - 1 ? 1.5 : 2
    ea[i] = i < n - 1 ? Arrow.none : (i % 3 === 0 ? Arrow.targetTriangle | Arrow.sourceCircle : Arrow.targetTriangle)
    ed[i] = i % 13 === 0 ? Dash.dashed : i % 17 === 0 ? Dash.dotted : Dash.solid
  }
  r.setEdgeStyle({ color: ec, width: ew, arrow: ea, dash: ed })
  r.setPositions(sim.positions())
  r.setLabels([{ node: 0, text: 'root', className: 'root' }])
  r.fit({ padding: 40 })
  return { n, sim, ends, degree, running: true, ticks: 0 }
}

let baseEdgeStyle: { color: Uint8Array; width: Float32Array; arrow: Uint8Array; dash: Uint8Array } | null = null
let simMs = 0
function frame() {
  const w = world
  if (w && w.running && !workerMode) {
    const t = performance.now()
    w.sim.tick(1)
    simMs = simMs * 0.9 + (performance.now() - t) * 0.1
    r.setPositions(w.sim.positions())
    w.ticks++
    if (w.sim.alpha() < w.sim.alphaMin()) w.running = false
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

let drawMs = 0
r.events.on('render', ({ frameMs }) => { drawMs = drawMs * 0.9 + frameMs * 0.1 })
setInterval(() => {
  if (!world) return
  hud.textContent = workerMode
    ? `${world.n} nodes, ${world.ends.length / 2} edges  [worker]\nsim ${workerStats.simMs.toFixed(1)} ms/tick in worker, ${workerStats.fps.toFixed(0)} frames/s  draw(cpu) ${drawMs.toFixed(2)} ms\ntick ${workerStats.tick}  alpha ${workerStats.alpha.toFixed(3)}\nzoom ${r.camera.zoom.toFixed(2)}  hover ${r.hoveredNode} / edge ${r.hoveredEdge}`
    : `${world.n} nodes, ${world.ends.length / 2} edges\nsim ${simMs.toFixed(2)} ms  draw(cpu) ${drawMs.toFixed(2)} ms\ntick ${world.ticks}  alpha ${world.sim.alpha().toFixed(3)}${world.running ? '' : ' (settled)'}\nzoom ${r.camera.zoom.toFixed(2)}  hover ${r.hoveredNode} / edge ${r.hoveredEdge}`
}, 250)

// interaction: hover label, edge hover highlight, edge click names both ends,
// drag pins through the simulation
const rootLabel = { node: 0, text: 'root', className: 'root' }
let selectedEdge = -1
function restyleEdges(hovered: number) {
  if (!baseEdgeStyle) return
  const color = new Uint8Array(baseEdgeStyle.color), width = new Float32Array(baseEdgeStyle.width)
  for (const e of [hovered, selectedEdge]) {
    if (e < 0) continue
    color.set([255, 209, 102, 255], 4 * e)
    width[e] = 4
  }
  r.setEdgeStyle({ color, width })
}
function labelsFor(node: number) {
  const labels = [rootLabel]
  if (node >= 0 && node !== 0) labels.push({ node, text: `node ${node} (deg ${world?.degree[node]})`, className: '' })
  if (selectedEdge >= 0) for (const n of r.edgeEnds(selectedEdge)) if (n !== 0 && n !== node) labels.push({ node: n, text: `node ${n}`, className: 'end' })
  return labels
}
r.events.on('hover', ({ node, edge }) => {
  r.setLabels(labelsFor(node))
  restyleEdges(edge)
})
r.events.on('click', ({ node, edge }) => {
  selectedEdge = node < 0 ? edge : -1
  r.setLabels(labelsFor(node))
  restyleEdges(edge)
})
r.events.on('dragstart', () => { if (!world) return; if (workerMode) worker?.postMessage({ type: 'alphaTarget', value: 0.3 } as Cmd); else { world.sim.setAlphaTarget(0.3); world.running = true } })
r.events.on('drag', ({ node, x, y }) => { if (workerMode) worker?.postMessage({ type: 'setFixed', node, x, y } as Cmd); else world?.sim.setFixed(node, x, y) })
r.events.on('dragend', ({ node, x, y }) => { if (!world) return; if (workerMode) { worker?.postMessage({ type: 'setFixed', node, x, y } as Cmd); worker?.postMessage({ type: 'alphaTarget', value: 0 } as Cmd) } else { world.sim.setFixed(node, x, y); world.sim.setAlphaTarget(0) } })
r.events.on('dblclick', ({ node }) => { if (node < 0) return; if (workerMode) worker?.postMessage({ type: 'setFixed', node, x: NaN, y: NaN } as Cmd); else world?.sim.setFixed(node, NaN, NaN) })

const sel = document.getElementById('n') as HTMLSelectElement
sel.onchange = () => { world = build(+sel.value) }
document.getElementById('fit')!.onclick = () => r.fit({ padding: 40, animate: 300 })
document.getElementById('toggle')!.onclick = () => { if (!world) return; if (workerMode) { world.running = !world.running; worker?.postMessage({ type: 'run', running: world.running } as Cmd) } else world.running = !world.running }
const modeSel = document.getElementById('mode') as HTMLSelectElement
modeSel.onchange = () => { workerMode = modeSel.value === 'worker'; if (!workerMode) { worker?.terminate(); worker = null } world = build(+sel.value) }

world = build(+sel.value)

declare global { interface Window { demo: { r: Edgelit; build: (n: number) => void; world: () => World | null; setWorkerMode: (on: boolean) => void; workerStats: () => typeof workerStats } } }
window.demo = { r, build: (n) => { world = build(n) }, world: () => world, setWorkerMode: (on) => { workerMode = on; if (!on) { worker?.terminate(); worker = null } }, workerStats: () => workerStats }
