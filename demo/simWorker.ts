// The simulation on its own thread, hosted by forcefield-sim's runtime.
// This file is a consumer-style worker entry: it loads wasm and installs
// the forces; the runtime handles frames, buffers and commands.
import init, * as wasm from 'forcefield-wasm'
import { serve } from 'forcefield-sim/worker'
import { forceCollide, forceLink, forceManyBody, forceX, forceY } from 'forcefield-sim'

serve({
  wasm: async () => { await init(); return wasm },
  setup(sim, _payload, { links }) {
    const degree = new Map<string, number>()
    for (const l of links as { source: string; target: string }[]) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1)
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1)
    }
    sim.alphaDecay(0.015).velocityDecay(0.35)
    sim.force('collide', forceCollide().radius(25).iterations(2))
      .force('link', forceLink(links).id((d: { id: string }) => d.id).distance(80).strength((l: { source: { index: number }; target: { index: number } }) => {
        const s = sim.nodes()[l.source.index], t = sim.nodes()[l.target.index]
        return 0.3 / Math.max(1, Math.min(degree.get(s.id as string) ?? 1, degree.get(t.id as string) ?? 1))
      }))
      .force('many-body', forceManyBody().strength(-150).distanceMin(5).distanceMax(250))
      .force('x', forceX().x(0).strength(0.05))
      .force('y', forceY().y(0).strength(0.05))
  },
})
