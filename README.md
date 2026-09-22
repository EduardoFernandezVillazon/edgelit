# edgelit

A WebGL2 graph renderer that draws from typed arrays. Positions go in as a
`Float64Array` or `Float32Array` each tick, pixels come out, and nothing
in between builds objects per node or per edge. Built to pair with an
external force simulation such as [forcefield](https://github.com/EduardoFernandezVillazon/forcefield),
a Rust/wasm port of d3-force whose positions are already a typed-array view.

What it draws: nodes as circles, squares, diamonds and hexagons with
optional solid or dashed borders; edges with width, colour, dash and dot
patterns, triangle target arrows and circle source markers. Edges that
share a node pair fan out as quadratic curves so an A→B and a B→A edge
stay distinguishable; everything else is straight. All of it anti-aliased
in the fragment shader and sized in world units, so it scales with zoom
exactly like a canvas graph would.

What it does not do, by design: layout, a graph model, styling by selector,
text rendering on the GPU. Labels are DOM elements for a subset of nodes
you choose, positioned every frame.

## How it works

Every node's `x, y, size, visible` lives in one RGBA32F texture, addressed
by node index. `setPositions` writes the new coordinates into that texture
and uploads it once. Nodes and edges are instanced: the vertex shader
fetches its endpoints from the texture with `texelFetch`, so an edge never
touches the CPU after it is created. Straight edges are one segment (four
vertices); curved ones are drawn in a second range with eight segments.
Per tick the CPU does one O(n) loop to pack positions (and convert from
float64) and one texture upload. Picking uses uniform spatial hashes over
the same float32 mirror: node centres for nodes, chord boxes for edges.

Measured in the WebKitGTK engine Tauri embeds on Linux, 20,000 nodes and
26,000 edges (5 % of them parallel pairs): a full frame including
`setPositions` and a GPU sync in 7 ms best-of-ten on an integrated Intel
GPU, with the machine otherwise busy. The simulation feeding it is the
bottleneck long before the renderer is.

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
r.events.on('hover', ({ node, edge, source, target }) => …)   // click, dblclick, contextmenu, dragstart/drag/dragend, viewport, render
r.pick(clientX, clientY)                        // node index or -1
r.pickEdge(clientX, clientY)                    // edge index or -1 (nodes are not considered)
r.edgeEnds(edge)                                // [source, target]
```

Style arrays are per node or per edge; pass only the fields that changed.
Pointer events carry `node` (or -1) and, when no node is under the
pointer, `edge` with its `source` and `target`; nodes win over edges. A
press on an edge pans. Dragging does not move nodes: the renderer reports
`drag` with world coordinates and the simulation owner decides (pin it
with `fx/fy`, for instance). Parallel-edge spacing is
`RendererOptions.parallelSpacing` (default 16 world units); pass
`curveParallel: false` to `setGraph` to draw everything straight. The
canvas's parent element must be positioned for labels.

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

0.2: curved parallel edges, node and edge picking, DOM labels for a
subset. Not in scope for now: self-loops (not drawn), GPU labels for
whole-graph labelling, touch gestures, box select. `docs/SPEC-0.2.md`
records the decisions.

MIT.
