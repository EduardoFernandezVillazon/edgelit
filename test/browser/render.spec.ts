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
