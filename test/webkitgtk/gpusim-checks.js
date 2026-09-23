// S0 spike checks (nemo-graph changes/2026-09-23-gpu-force-layout.md): the two
// extension gates, then per size: ms/tick (GPU-bound, gl.finish), ticks/s
// when ticking once per rAF, rAF p50/p95 while doing so, and a full
// synchronous readback of the position texture.
const results = []
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 100 && !window.gpusim; i++) await wait(100)
const { sim } = window.gpusim
const gl = sim.gl
const dbg = gl.getExtension('WEBGL_debug_renderer_info')
const engine = { ua: navigator.userAgent, version: gl.getParameter(gl.VERSION), renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), cores: navigator.hardwareConcurrency }
check('EXT_color_buffer_float (render to float)', sim.ext.EXT_color_buffer_float, sim.ext)
check('EXT_float_blend (additive float blending for the grid levels)', sim.ext.EXT_float_blend, sim.ext)

async function measure(n) {
  const g = sim.build(n)
  for (let i = 0; i < 5; i++) sim.tick()
  sim.finish()
  const K = n >= 100000 ? 20 : 40
  let t0 = performance.now()
  for (let i = 0; i < K; i++) sim.tick()
  sim.finish()
  const msPerTick = (performance.now() - t0) / K
  t0 = performance.now(); const rb = sim.readback(); const readbackMs = performance.now() - t0
  const finite = Number.isFinite(rb[0]) && Number.isFinite(rb[4 * (n - 1)])
  // tick once per animation frame for 2.5 s: the shape a live layout would have
  const intervals = []; let last = performance.now(); const ticks0 = sim.ticks; const start = last
  while (performance.now() - start < 2500) {
    sim.tick()
    await new Promise((res) => requestAnimationFrame(res))
    const now = performance.now(); intervals.push(now - last); last = now
  }
  const elapsed = (performance.now() - start) / 1000
  intervals.sort((a, b) => a - b)
  const p = (q) => +intervals[Math.floor(intervals.length * q)].toFixed(1)
  return { n, links: g.links, msPerTick: +msPerTick.toFixed(2), readbackMs: +readbackMs.toFixed(2), finite, ticksPerS: +((sim.ticks - ticks0) / elapsed).toFixed(1), rafP50: p(0.5), rafP95: p(0.95), rafMax: +intervals[intervals.length - 1].toFixed(1) }
}
const rows = []
for (const n of [5000, 20000, 100000]) rows.push(await measure(n))
const r20 = rows.find((x) => x.n === 20000)
check('positions stay finite after ticking', rows.every((x) => x.finite), rows.map((x) => x.finite))
check('GO criterion: 20k nodes ≥ 30 ticks/s with rAF p95 ≤ 20 ms', r20.ticksPerS >= 30 && r20.rafP95 <= 20, r20)
return { ok: results.every((x) => x.pass), engine, rows, results }
