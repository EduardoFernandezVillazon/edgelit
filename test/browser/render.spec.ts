import { expect, test } from '@playwright/test'

// Runs against the demo page in WebKit (the WebKitGTK engine Tauri uses).

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => !!window.demo?.world())
})

test('WebGL2 context is real and renders nodes at the expected screen position', async ({ page }) => {
  const info = await page.evaluate(() => {
    const gl = window.demo.r.gl
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    return {
      version: gl.getParameter(gl.VERSION) as string,
      renderer: dbg ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string) : gl.getParameter(gl.RENDERER),
      floatTex: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    }
  })
  console.log('GL:', info)
  expect(info.version).toContain('WebGL 2')

  // Pause, place node 0 at a known world point, read the pixel there.
  const px = await page.evaluate(() => {
    const { r, world } = window.demo
    const w = world()!
    w.running = false
    const p = w.sim.positions()
    p[0] = -1e5; p[1] = -1e5 // far from every other node
    r.setPositions(p)
    r.camera.x = -1e5; r.camera.y = -1e5; r.camera.zoom = 1
    r.render()
    const [sx, sy] = r.camera.worldToScreen(-1e5, -1e5)
    const gl = r.gl
    const dpr = r.canvas.width / r.canvas.clientWidth
    const buf = new Uint8Array(4)
    r.render()
    gl.readPixels(Math.round(sx * dpr), Math.round(r.canvas.height - sy * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    return Array.from(buf)
  })
  // node 0 is the gold diamond (255, 209, 102)
  expect(px[0]).toBeGreaterThan(200)
  expect(px[1]).toBeGreaterThan(150)
  expect(px[2]).toBeLessThan(160)
})

test('picking finds the node under the pointer and hover fires', async ({ page }) => {
  const result = await page.evaluate(() => {
    const { r, world } = window.demo
    const w = world()!
    w.running = false
    const p = w.sim.positions()
    p[2] = 300; p[3] = 100 // node 1
    r.setPositions(p)
    r.camera.x = 0; r.camera.y = 0; r.camera.zoom = 1
    r.render()
    const [sx, sy] = r.camera.worldToScreen(300, 100)
    return { hit: r.pick(sx, sy), miss: r.pick(-1e6, -1e6), sx, sy }
  })
  expect(result.hit).toBe(1)
  const canvas = page.locator('#c')
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + result.sx, box.y + result.sy)
  await page.waitForFunction(() => window.demo.r.hoveredNode === 1)
})

test('20k nodes: frame cost stays interactive', async ({ page }) => {
  const stats = await page.evaluate(async () => {
    const { r, build, world } = window.demo
    build(20000)
    const w = world()!
    const t0 = performance.now()
    let frames = 0
    const sims: number[] = []
    const draws: number[] = []
    while (performance.now() - t0 < 3000) {
      const a = performance.now()
      w.sim.tick(1)
      const b = performance.now()
      r.setPositions(w.sim.positions())
      r.render()
      const c = performance.now()
      sims.push(b - a)
      draws.push(c - b)
      frames++
      await new Promise((res) => requestAnimationFrame(res))
    }
    const med = (xs: number[]) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)]
    return { frames, simMs: med(sims), drawMs: med(draws), edges: w.ends.length / 2 }
  })
  console.log('20k:', stats)
  expect(stats.frames).toBeGreaterThan(5) // the simulation dominates at 20k; draw cost is the assertion that matters
  expect(stats.drawMs).toBeLessThan(16)
})

test('parallel edges curve apart and edges are pickable', async ({ page }) => {
  const res = await page.evaluate(() => {
    const results: { name: string; pass: boolean; detail?: unknown }[] = []
    const check = (name: string, pass: boolean, detail?: unknown) => results.push({ name, pass, detail })
    const { r, world } = window.demo
    const gl = r.gl
    {
      const w = world()!
      w.running = false
      const p = w.sim.positions()
      const ends = w.ends
      // find a bidirectional pair
      let pair = -1
      const key = (i: number) => Math.min(ends[2 * i], ends[2 * i + 1]) * 1e6 + Math.max(ends[2 * i], ends[2 * i + 1])
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
      const px = (wx: number, wy: number) => { const [sx, sy] = r.camera.worldToScreen(wx, wy); const buf = new Uint8Array(4); gl.readPixels(Math.round(sx * dpr), Math.round(r.canvas.height - sy * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf); return Array.from(buf) }
      const bg = px(5e4 + 150, 5e4 + 60)
      const mid = px(5e4 + 150, 5e4)
      const up = px(5e4 + 150, 5e4 - Math.abs(off))
      const down = px(5e4 + 150, 5e4 + Math.abs(off))
      const isBg = (c: number[]) => Math.abs(c[0] - bg[0]) < 8 && Math.abs(c[1] - bg[1]) < 8 && Math.abs(c[2] - bg[2]) < 8
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
    return results
  })
  for (const c of res) expect(c.pass, `${c.name}: ${JSON.stringify(c.detail)}`).toBe(true)
})

test('edge hover event fires with source and target', async ({ page }) => {
  const target = await page.evaluate(() => {
    const { r, world } = window.demo
    const w = world()!
    w.running = false
    const p = w.sim.positions()
    // isolate edge 0 (n0 → n1... use ends) far away
    const a = w.ends[0], b = w.ends[1]
    p[2 * a] = -7e4; p[2 * a + 1] = -7e4; p[2 * b] = -7e4 + 200; p[2 * b + 1] = -7e4
    r.setPositions(p)
    r.camera.x = -7e4 + 100; r.camera.y = -7e4; r.camera.zoom = 1
    r.render()
    const off = r.edgeOffsets[0]
    const [sx, sy] = r.camera.worldToScreen(-7e4 + 100, -7e4 - off)
    return { sx, sy, a, b }
  })
  const box = (await page.locator('#c').boundingBox())!
  await page.mouse.move(box.x + 5, box.y + 5)
  await page.mouse.move(box.x + target.sx, box.y + target.sy)
  await page.waitForFunction(() => window.demo.r.hoveredEdge >= 0)
  await page.evaluate(() => {
    ;(window as unknown as { __click?: unknown }).__click = undefined
    window.demo.r.events.on('click', (e) => { (window as unknown as { __click?: unknown }).__click = { edge: e.edge, source: e.source, target: e.target } })
  })
  await page.mouse.click(box.x + target.sx, box.y + target.sy)
  await page.waitForFunction(() => (window as unknown as { __click?: unknown }).__click !== undefined)
  const got = await page.evaluate(() => (window as unknown as { __click: { edge: number; source: number; target: number } }).__click)
  expect(got.edge).toBeGreaterThanOrEqual(0)
  expect([got.source, got.target].sort()).toEqual([target.a, target.b].sort())
})

