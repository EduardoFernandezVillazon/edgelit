// S1 checks for nemo-graph's GPU layout: behaviour on tiny graphs (exact
// enough to assert), then the cost table with rendering on.
// The runner's load-changed FINISHED can fire more than once on a Vite dev
// page (HMR client connect), which starts this script twice; a second copy's
// synchronous settle loops looked like a 2.5 s hitch in the first copy's
// frame timing and its build() reset the tick counter mid-window.
if (window.__gpulayoutChecksStarted) { await new Promise(() => {}) }
window.__gpulayoutChecksStarted = true
console.log('gpulayout checks start', Math.round(performance.now()))
const results = []
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 100 && !window.gpulayout; i++) await wait(100)
const { r, layout, build, setPaused } = window.gpulayout
setPaused(true)
const gl = r.gl
const engine = { ua: navigator.userAgent, version: gl.getParameter(gl.VERSION), cores: navigator.hardwareConcurrency, ext: layout.ext }
const pos = (i) => { const p = layout.readbackNow(); return [p[2 * i], p[2 * i + 1]] }
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
const settle = (ticks) => { for (let i = 0; i < ticks; i++) layout.tick() }

// 1. two linked nodes settle near linkDistance (80)
build(2, { links: { src: [0], tgt: [1] }, adaptive: false, noCentre: true })
settle(600)
const d01 = dist(pos(0), pos(1))
check('two linked nodes settle near the link distance (80)', d01 > 60 && d01 < 110, { d01 })

// 2. two unlinked nodes repel apart
build(2, { links: { src: [], tgt: [] }, adaptive: false, noCentre: true })
layout.setPosition(0, -2, 0); layout.setPosition(1, 2, 0)
settle(200)
const dRep = dist(pos(0), pos(1))
check('two free nodes repel apart (start 4 apart)', dRep > 40, { dRep })

// 3. a pin holds through ticking
build(3, { links: { src: [0, 1], tgt: [1, 2] }, pins: [[1, 123, -45]], adaptive: false })
settle(300)
const p1 = pos(1)
check('a pinned node stays exactly where it was pinned', Math.abs(p1[0] - 123) < 1e-3 && Math.abs(p1[1] + 45) < 1e-3, { p1 })
layout.setFixed(1, NaN, NaN); settle(100)
check('unpinning frees it (moves off the pin)', dist(pos(1), [123, -45]) > 0.5, { p1: pos(1) })

// 4. a DAG pair orders left → right by the gap
build(2, { links: { src: [], tgt: [] }, dagPairs: [[0, 1]], adaptive: false, noCentre: true })
layout.setPosition(0, -10, 0); layout.setPosition(1, 10, 0)   // ordered but far too close: the gap force must spread them
settle(600)
const a = pos(0), b = pos(1)
check('DAG pair: left ends up left of right by ~the gap (120)', b[0] - a[0] > 90, { left: a, right: b })

// 5. adaptive cooling: the run ENDS on its own (alpha reaches alphaMin)
build(200, { adaptive: true })
let ended = false; layout.on('end.test', () => { ended = true })
// tick in batches that yield: fences (readbacks → cooling samples) only signal between tasks
for (let b = 0; b < 400 && !ended; b++) { for (let i = 0; i < 10 && !ended; i++) layout.tick(); await wait(0) }
check('adaptive cooling lets a 200-node layout end by itself', ended, { ticks: layout.ticks, alpha: layout.alpha(), decay: layout.alphaDecay() })

// 6. cost with rendering on: tick + blit + draw per frame, 4 s window; any
// frame gap over 100 ms is logged with its moment and tick so a hitch is
// visible as what it is instead of being averaged into ticks/s.
const raf = () => new Promise((res) => requestAnimationFrame(res))
async function measure(n) {
  build(n, { adaptive: false })
  setPaused(false)
  await wait(300)
  window.__stepMax = 0
  const intervals = [], stalls = []
  let last = performance.now(); const t0 = last; const ticks0 = layout.ticks
  let draw = 0, frames = 0
  const off = r.events.on('render', ({ frameMs }) => { draw += frameMs; frames++ })
  while (performance.now() - t0 < (n === 100000 ? 4000 : 8000)) {
    await raf()
    const now = performance.now(); const dt = now - last
    intervals.push(dt)
    if (dt > 100) stalls.push({ atMs: Math.round(now - t0), dt: Math.round(dt), tick: layout.ticks })
    last = now
  }
  // The offscreen WebKitGTK harness freezes for ~2.5 s every ~7 s even when
  // the page is idle (gpulayout-bisect.js); ticks/s is reported net of those
  // gaps, which are listed per row so nobody has to take that on trust.
  const stalled = stalls.reduce((a, x) => a + x.dt, 0) / 1000
  const elapsed = (performance.now() - t0) / 1000 - stalled
  const ticks = layout.ticks - ticks0
  off()
  setPaused(true)
  const stepMax = window.__stepMax
  intervals.sort((x, y) => x - y)
  const p = (q) => +intervals[Math.floor(intervals.length * q)].toFixed(1)
  for (let i = 0; i < 5; i++) layout.tick(); gl.finish()
  const t1 = performance.now(); for (let i = 0; i < 30; i++) layout.tick(); gl.finish()
  return { n, ticksPerS: +(ticks / elapsed).toFixed(1), rafP50: p(0.5), rafP95: p(0.95), rafMax: +intervals[intervals.length - 1].toFixed(1), stalls, stepCpuMaxMs: +stepMax.toFixed(1), drawMsPerFrame: +(draw / Math.max(1, frames)).toFixed(2), layoutGpuMsPerTick: +((performance.now() - t1) / 30).toFixed(2), stillRunning: layout.running, alpha: +layout.alpha().toFixed(3) }
}
const rows = []
for (const n of [5000, 14000, 20000, 100000]) rows.push(await measure(n))
const r14 = rows.find((x) => x.n === 14000)
check('14k nodes (the real corpus) tick at ≥ 30/s with rendering, rAF p95 ≤ 20 ms', r14.ticksPerS >= 30 && r14.rafP95 <= 20, r14)
check('every frame gap over 100 ms is one of the harness freezes (~2.5 s), never a layout hitch', rows.every((x) => x.stalls.every((st) => st.dt > 2000)), rows.map((x) => [x.n, x.stalls]))
return { ok: results.every((x) => x.pass), engine, rows, results }
