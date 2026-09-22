// Exploration: simulation on the main thread vs in a Web Worker.
// For each size, measures over 4 s: main-thread rAF interval (p50/p95, how
// smooth pan/zoom would feel), simulation ticks per second, and the CPU
// time the main thread spends per frame.
const results = []
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 100 && !(window.demo && window.demo.world()); i++) await wait(100)
const { r, build, world, setWorkerMode, workerStats } = window.demo
const ua = navigator.userAgent
const cores = navigator.hardwareConcurrency

async function measure(n, mode) {
  setWorkerMode(mode === 'worker')
  build(n)
  await wait(mode === 'worker' ? 1500 : 500) // worker: wasm init + first frames
  const w = world()
  const intervals = []
  let drawCpu = 0, frames = 0
  const off = r.events.on('render', ({ frameMs }) => { drawCpu += frameMs; frames++ })
  const ticks0 = mode === 'worker' ? workerStats().tick : w.ticks
  const t0 = performance.now()
  let last = t0
  while (performance.now() - t0 < 4000) {
    await new Promise((res) => requestAnimationFrame(res))
    const now = performance.now()
    intervals.push(now - last)
    last = now
  }
  off()
  const elapsed = (performance.now() - t0) / 1000
  const ticks = (mode === 'worker' ? workerStats().tick : w.ticks) - ticks0
  intervals.sort((a, b) => a - b)
  const p = (q) => +intervals[Math.floor(intervals.length * q)].toFixed(1)
  return { n, mode, rafP50: p(0.5), rafP95: p(0.95), rafMax: +intervals[intervals.length - 1].toFixed(1), ticksPerS: +(ticks / elapsed).toFixed(1), drawCpuMsPerFrame: +(drawCpu / Math.max(1, frames)).toFixed(2), simMsPerTick: mode === 'worker' ? +workerStats().simMs.toFixed(1) : null }
}

const rows = []
for (const n of [5000, 10000, 20000]) {
  for (const mode of ['inline', 'worker']) rows.push(await measure(n, mode))
}
setWorkerMode(false)
check('worker mode delivered frames at every size', rows.filter((x) => x.mode === 'worker').every((x) => x.ticksPerS > 0), rows)
check('worker mode keeps main-thread rAF p95 under 20 ms at 20k', rows.find((x) => x.mode === 'worker' && x.n === 20000).rafP95 < 20, rows.find((x) => x.mode === 'worker' && x.n === 20000))
return { ok: results.every((x) => x.pass), engine: { ua, cores }, rows, results }
