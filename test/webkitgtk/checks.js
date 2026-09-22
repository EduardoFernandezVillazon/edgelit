// Runs inside the demo page. Returns { ok, engine, results: [...] }.
const results = []
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 100 && !(window.demo && window.demo.world()); i++) await wait(100)
const { r, build, world } = window.demo
const gl = r.gl
const dbg = gl.getExtension('WEBGL_debug_renderer_info')
const engine = {
  ua: navigator.userAgent,
  version: gl.getParameter(gl.VERSION),
  renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
  vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
  dpr: devicePixelRatio,
}
check('webgl2', String(engine.version).includes('WebGL 2'), engine.version)

// 1. pixel at node 0
{
  const w = world()
  w.running = false
  const p = w.sim.positions()
  p[0] = -1e5; p[1] = -1e5 // far from every other node
  r.setPositions(p)
  r.camera.x = -1e5; r.camera.y = -1e5; r.camera.zoom = 1
  r.render(); r.render()
  const [sx, sy] = r.camera.worldToScreen(-1e5, -1e5)
  const dpr = r.canvas.width / r.canvas.clientWidth
  const buf = new Uint8Array(4)
  gl.readPixels(Math.round(sx * dpr), Math.round(r.canvas.height - sy * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  check('node0 pixel is gold', buf[0] > 200 && buf[1] > 150 && buf[2] < 160, Array.from(buf))
}

// 2. picking
{
  const w = world()
  const p = w.sim.positions()
  p[2] = 300; p[3] = 100
  r.setPositions(p)
  r.render()
  const [sx, sy] = r.camera.worldToScreen(300, 100)
  check('pick hit', r.pick(sx, sy) === 1, r.pick(sx, sy))
  check('pick miss', r.pick(-1e6, -1e6) === -1)
}


// 4. curved parallel edges: A→B and B→A separate; chord midpoint is background
{
  const w = world()
  w.running = false
  const p = w.sim.positions()
  const ends = w.ends
  // find a bidirectional pair
  let pair = -1
  const key = (i) => Math.min(ends[2 * i], ends[2 * i + 1]) * 1e6 + Math.max(ends[2 * i], ends[2 * i + 1])
  const seen = new Map()
  for (let i = 0; i < ends.length / 2; i++) { const k = key(i); if (seen.has(k) && ends[2 * i] !== ends[2 * seen.get(k)]) { pair = i; break } seen.set(k, i) }
  check('has a bidirectional pair', pair >= 0, pair)
  const a = ends[2 * pair], b = ends[2 * pair + 1]
  const off = r.edgeOffsets[pair]
  check('pair has non-zero offset', off !== 0, off)
  // isolate the pair far away, horizontal, 300 apart
  p[2 * a] = 5e4; p[2 * a + 1] = 5e4; p[2 * b] = 5e4 + 300; p[2 * b + 1] = 5e4
  r.setPositions(p)
  r.camera.x = 5e4 + 150; r.camera.y = 5e4; r.camera.zoom = 1
  r.render(); r.render()
  const dpr = r.canvas.width / r.canvas.clientWidth
  const px = (wx, wy) => { const [sx, sy] = r.camera.worldToScreen(wx, wy); const buf = new Uint8Array(4); gl.readPixels(Math.round(sx * dpr), Math.round(r.canvas.height - sy * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf); return Array.from(buf) }
  const bg = px(5e4 + 150, 5e4 + 60)
  const mid = px(5e4 + 150, 5e4)
  const up = px(5e4 + 150, 5e4 - Math.abs(off))
  const down = px(5e4 + 150, 5e4 + Math.abs(off))
  const isBg = (c) => Math.abs(c[0] - bg[0]) < 8 && Math.abs(c[1] - bg[1]) < 8 && Math.abs(c[2] - bg[2]) < 8
  check('chord midpoint is background (edges bent away)', isBg(mid), { mid, bg })
  check('curve passes offset above', !isBg(up), up)
  check('curve passes offset below', !isBg(down), down)
  // pick the upper curve and the lower one
  const [ux, uy] = r.camera.worldToScreen(5e4 + 150, 5e4 - Math.abs(off))
  const [dx, dy] = r.camera.worldToScreen(5e4 + 150, 5e4 + Math.abs(off))
  const eu = r.pickEdge(ux, uy), edn = r.pickEdge(dx, dy)
  check('edge pick hits both curves with different edges', eu >= 0 && edn >= 0 && eu !== edn, [eu, edn])
  const [mx, my] = r.camera.worldToScreen(5e4 + 150, 5e4)
  check('edge pick misses the chord midpoint', r.pickEdge(mx, my) === -1, r.pickEdge(mx, my))
  const [ax, ay] = r.camera.worldToScreen(5e4, 5e4)
  check('node wins over edge', r.pick(ax, ay) === a, r.pick(ax, ay))
  const ends2 = r.edgeEnds(eu)
  check('edgeEnds returns the pair', (ends2[0] === a && ends2[1] === b) || (ends2[0] === b && ends2[1] === a), ends2)
}

// 3. 20k timing
{
  build(20000)
  const w = world()
  const t0 = performance.now()
  const sims = [], draws = []
  while (performance.now() - t0 < 3000) {
    const a = performance.now(); w.sim.tick(1)
    const b = performance.now(); r.setPositions(w.sim.positions()); r.render()
    const c = performance.now()
    sims.push(b - a); draws.push(c - b)
    await new Promise((res) => requestAnimationFrame(res))
  }
  const med = (xs) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)]
  const stats = { frames: sims.length, simMs: +med(sims).toFixed(2), drawCpuMs: +med(draws).toFixed(2), edges: w.ends.length / 2 }
  check('20k draw cpu < 16ms', stats.drawCpuMs < 16, stats)
  // GPU-side cost: readPixels forces completion; time a frame including it.
  w.running = false
  const synced = []
  for (let k = 0; k < 10; k++) {
    const g0 = performance.now(); r.setPositions(w.sim.positions()); r.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); synced.push(performance.now() - g0)
    await new Promise((res) => requestAnimationFrame(res))
  }
  // The minimum approximates the uncontended cost; the median is reported for context.
  const syncedMin = Math.min(...synced), syncedMed = med(synced.slice())
  check('20k frame incl. gpu sync < 8ms (0.2 budget), best of 10', syncedMin < 8, { minMs: +syncedMin.toFixed(2), medianMs: +syncedMed.toFixed(2), all: synced.map((x) => +x.toFixed(1)) })
}

return { ok: results.every((x) => x.pass), engine, results }
