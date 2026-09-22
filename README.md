# edgelit

A WebGL2 graph renderer that draws from typed arrays. Positions go in as a
`Float64Array` or `Float32Array` each tick, pixels come out, and nothing
in between builds objects per node or per edge. Built to pair with an
external force simulation such as [forcefield](https://github.com/EduardoFernandezVillazon/forcefield),
a Rust/wasm port of d3-force whose positions are already a typed-array view.

What it draws: nodes as circles, squares, diamonds and hexagons with
optional solid or dashed borders; straight edges with width, colour, dash
and dot patterns, triangle target arrows and circle source markers. All of
it anti-aliased in the fragment shader and sized in world units, so it
scales with zoom exactly like a canvas graph would.

What it does not do, by design: layout, a graph model, styling by selector,
text rendering on the GPU. Labels are DOM elements for a subset of nodes
you choose, positioned every frame.

## How it works

Every node's `x, y, size, visible` lives in one RGBA32F texture, addressed
by node index. `setPositions` writes the new coordinates into that texture
and uploads it once. Nodes and edges are instanced quads: the vertex shader
fetches its endpoints from the texture with `texelFetch`, so an edge never
touches the CPU after it is created. Per tick the CPU does one O(n) loop
to pack positions (and convert from float64) and one texture upload.
Picking uses a uniform spatial hash over the same float32 mirror.

Measured in the WebKitGTK engine Tauri embeds on Linux, 20,000 nodes and
25,000 edges: a full frame including GPU sync in about 4 ms on an
integrated Intel GPU. The simulation feeding it is the bottleneck long
before the renderer is.

## Use

```ts
import { Edgelit, Shape, Dash, Arrow } from 'edgelit'

const r = new Edgelit(canvas, { background: [0.09, 0.09, 0.11, 1] })
r.setGraph({ nodeCount: n, edges: Uint32Array /* [s0, t0, s1, t1, …] */ })
r.setNodeStyle({ size, color /* RGBA bytes */, shape, borderWidth, borderColor, borderDash })
r.setEdgeStyle({ color, width, arrow, dash })
r.setVisibility(mask)                          // Uint8Array, 0 hides a node and its edges

// each simulation tick
r.setPositions(sim.positions())                // Float64Array view straight from wasm

r.fit({ padding: 40, animate: 300 })
r.setLabels([{ node: 0, text: 'root', className: 'root' }])
r.events.on('hover', ({ node }) => …)          // click, dblclick, contextmenu, dragstart/drag/dragend, viewport, render
r.pick(clientX, clientY)                        // node index or -1
```

Style arrays are per node or per edge; pass only the fields that changed.
Dragging does not move nodes: the renderer reports `drag` with world
coordinates and the simulation owner decides (pin it with `fx/fy`, for
instance). The canvas's parent element must be positioned for labels.

The demo (`npm run dev`) drives edgelit from forcefield-wasm and is also
the harness the tests run against.

## Tests

```
npm test               # vitest: camera maths, spatial grid
npm run test:browser   # Playwright, Chromium: pixel, picking, 20k-node timing
python3 test/webkitgtk/run.py   # the same checks inside the system WebKitGTK (needs a Linux desktop session)
```

The WebKitGTK harness exists because Playwright's own WebKit build does
not run on every distribution and because the engine matters: ANGLE in
WebKitGTK rejected a reserved GLSL word that other engines let through.

## Status

0.1: straight edges only, node picking only, no touch gestures, no box
select. Planned: quadratic curves for parallel edges, GPU glyph labels for
whole-graph labelling, edge picking, pinch zoom.

MIT.
