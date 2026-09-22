// The simulation on its own thread. Owns a forcefield-wasm Simulation and
// streams positions to the main thread as transferable Float32Array buffers
// (ping-pong: the main thread hands each buffer back after drawing), so no
// SharedArrayBuffer and no cross-origin isolation are needed.
//
// Everything that touches the simulation runs here: forces, adaptive
// cooling, pins from drag. The main thread sends commands and receives
// frames.
import init, { Simulation } from 'forcefield-wasm'

export type Cmd =
  | { type: 'init'; n: number; positions: Float64Array; src: Uint32Array; tgt: Uint32Array; strength: Float64Array; bufferCount: number }
  | { type: 'buffer'; buf: ArrayBuffer }          // a drawn frame's buffer, returned for reuse
  | { type: 'setFixed'; node: number; x: number; y: number }
  | { type: 'alphaTarget'; value: number }
  | { type: 'run'; running: boolean }
export type Frame = { type: 'frame'; buf: ArrayBuffer; tick: number; alpha: number; simMs: number }

let sim: Simulation | null = null
let n = 0
let tick = 0
let running = true
const free: ArrayBuffer[] = []
let pending = false

function step() {
  if (!sim || !running || pending) return
  const buf = free.pop()
  if (!buf) return // main thread still drawing every buffer: skip until one returns (back-pressure)
  const t0 = performance.now()
  sim.tick(1)
  const simMs = performance.now() - t0
  const out = new Float32Array(buf)
  out.set(sim.positions()) // f64 → f32 copy, O(n)
  tick++
  const alpha = sim.alpha()
  if (alpha < sim.alphaMin()) running = false
  const msg: Frame = { type: 'frame', buf, tick, alpha, simMs }
  ;(self as unknown as Worker).postMessage(msg, [buf])
}

self.onmessage = async (e: MessageEvent<Cmd>) => {
  const m = e.data
  switch (m.type) {
    case 'init': {
      await init()
      sim?.free()
      n = m.n
      sim = Simulation.fromPositions(m.positions)
      sim.setAlphaDecay(0.015); sim.setVelocityDecay(0.35)
      sim.forceCollide('collide', Float64Array.of(25), 1, 2)
      sim.forceLink('link', m.src, m.tgt, Float64Array.of(80), m.strength, 1)
      sim.forceManyBody('many-body', Float64Array.of(-150), 0.9, 5, 250)
      sim.forceX('x', Float64Array.of(0), Float64Array.of(0.05)); sim.forceY('y', Float64Array.of(0), Float64Array.of(0.05))
      free.length = 0
      for (let i = 0; i < m.bufferCount; i++) free.push(new ArrayBuffer(2 * n * 4))
      tick = 0
      running = true
      break
    }
    case 'buffer':
      free.push(m.buf)
      break
    case 'setFixed':
      sim?.setFixed(m.node, m.x, m.y)
      break
    case 'alphaTarget':
      sim?.setAlphaTarget(m.value)
      if (m.value > 0) running = true
      break
    case 'run':
      running = m.running
      break
  }
  step()
}

// Tick as fast as buffers come back; setTimeout(0) keeps the worker responsive to commands.
function loop() { step(); setTimeout(loop, 0) }
loop()
