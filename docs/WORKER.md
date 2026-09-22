# Simulation in a Web Worker

Exploration, 2026-09-22, measured in system WebKitGTK 2.52 (the engine
Tauri embeds) on an 8-core laptop with an integrated Intel GPU, load
average about 3. `npm run dev`, then
`python3 test/webkitgtk/run.py http://localhost:5180/ test/webkitgtk/worker-checks.js`.

## Question

At more than a few thousand nodes the wasm simulation costs tens of
milliseconds per tick. Inline, that blocks the main thread: pan, zoom,
hover and the rest of the UI stall between ticks. Does moving the
simulation to a worker fix the stall without slowing the simulation?

## Result

| nodes | mode | rAF p50 | rAF p95 | rAF max | ticks/s | main-thread draw CPU | sim ms/tick |
|---:|---|---:|---:|---:|---:|---:|---:|
| 5 000 | inline | 17 | 19 | 25 | 58.8 | 0.15 | 12 |
| 5 000 | worker | 17 | 17 | 18 | 71.5 | 0.19 | 11.9 |
| 10 000 | inline | 42 | 51 | 60 | 23.2 | 0.20 | 37 |
| 10 000 | worker | 17 | 17 | 18 | 25.0 | 0.32 | 37.5 |
| 20 000 | inline | 103 | 120 | 121 | 9.5 | 0.15 | 103 |
| 20 000 | worker | 17 | 17 | 18 | 9.5 | 0.26 | 103.7 |

rAF interval is the time between animation frames on the main thread:
17 ms is a steady 60 Hz. Inline, the interval is the tick cost. In the
worker, the main thread stays at 60 Hz at every size, spending well under
a millisecond per frame, while the simulation runs at exactly the rate it
ran inline. Nothing is lost; the stall is gone. At 20 000 nodes the
layout still evolves at 9 or 10 ticks per second, which reads as a slow
settle rather than a frozen window.

## Protocol

Now implemented as the `forcefield-sim` package (`forcefield-sim/worker`
and `forcefield-sim/client`); `demo/simWorker.ts` is a consumer-style
worker entry using it. Re-measured on the published runtime, 2026-09-22
evening: identical figures (main thread 17 ms p50/18 ms p95 at every size,
tick rates within noise of inline).

- The worker owns the wasm `Simulation` and everything that touches it.
- Positions travel as transferable `Float32Array` buffers: the worker
  copies the wasm `Float64Array` view into a buffer (one O(n) loop) and
  posts it with transfer; the main thread calls `setPositions` on it and
  posts the buffer back. Three buffers in flight give back-pressure for
  free: when the main thread has not returned a buffer, the worker skips
  ticking rather than piling up frames.
- No `SharedArrayBuffer`, so no cross-origin isolation headers and no
  threaded wasm build.
- Commands from the main thread: pin (`setFixed`), re-heat
  (`alphaTarget`), pause, and structure changes (re-`init`).

## What this means for a consumer such as nemo-graph

The code that reaches into `layout.simulation` today moves into the
worker, unchanged in logic:

- **Adaptive cooling** reads positions every tick to compute mean squared
  displacement and toggles `alphaDecay`. It must live where every tick is
  observed, which is the worker (the main thread may skip frames).
- **The DAG direction force** is a JS force over node objects. The worker
  hosts the d3-shaped `Simulation` facade from `cytoscape-forcefield/simulation`
  and installs the force there; the main thread sends the pairs.
- **Drag** becomes two messages: pin during drag, re-heat on grab and
  release. One frame of latency between pointer and pinned position is
  not perceptible at 60 Hz.
- **Depth centring, subgraph focus, pinned-position restore** are all
  `setFixed` calls, so they are messages too.

The facade module has no DOM dependencies and runs in a worker as is;
`graphLayout.js` would need its DOM-dependent theme helpers split from
the simulation helpers before it can be imported there.

## Recommendation

Do this as part of the renderer integration rather than after it: the
graph host's shape (commands in, frames out) is the same either way, and
adding the worker later would mean moving the simulation code twice.
With it, the live-layout node limit is set by how slow a settle you will
accept, not by frame rate.
