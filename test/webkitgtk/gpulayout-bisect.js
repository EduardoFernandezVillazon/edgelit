// Bisect the periodic ~2.5 s frame freeze: same graph, three configurations.
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const raf = () => new Promise((res) => requestAnimationFrame(res))
for (let i = 0; i < 100 && !window.gpulayout; i++) await wait(100)
const { r, layout, build, setPaused } = window.gpulayout
async function run(label, cfg) {
  build(14000, { adaptive: false })
  layout.opts.readbackEvery = cfg.readbacks ? 6 : 1e9
  setPaused(true)
  await wait(300)
  const stalls = []; let last = performance.now(); const t0 = last; let ticks = 0
  while (performance.now() - t0 < 9000) {
    if (cfg.tick) { layout.tick(); ticks++ }
    if (cfg.blit) { const { tex, rows } = r.positionTexture; layout.blitInto(tex, rows); r.requestRender() }
    await raf()
    const now = performance.now(); const dt = now - last
    if (dt > 100) stalls.push({ atMs: Math.round(now - t0), dt: Math.round(dt) })
    last = now
  }
  return { label, ticks, stalls }
}
const out = []
out.push(await run('tick + blit + readback (as the demo)', { tick: true, blit: true, readbacks: true }))
out.push(await run('tick + blit, no readback', { tick: true, blit: true, readbacks: false }))
out.push(await run('tick only, no blit, no readback', { tick: true, blit: false, readbacks: false }))
out.push(await run('idle: no tick, no blit (baseline of the page + runner)', { tick: false, blit: false, readbacks: false }))
layout.opts.readbackEvery = 6
return { ok: true, out }
