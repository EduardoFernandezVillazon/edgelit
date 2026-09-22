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
  const g0 = performance.now(); r.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); const g1 = performance.now()
  check('20k frame incl. gpu sync < 33ms', g1 - g0 < 33, +(g1 - g0).toFixed(2))
}

return { ok: results.every((x) => x.pass), engine, results }
