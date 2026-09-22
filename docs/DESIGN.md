# Design notes

2026-09-22.

## Why a renderer and not a port of cytoscape

The cost in a graph renderer is the shape of the work, not the language.
cytoscape.js spends its time in a selector-driven style engine, per-element
canvas draw calls and DOM event plumbing. Moving that to Rust would keep
the shape and add a wasm boundary crossing per call. What removes the cost
is a different shape: positions in typed arrays, one upload per tick, all
nodes in one instanced draw, edges resolved on the GPU.

## Why a separate project

The renderer has no application-specific semantics: it takes indices,
arrays and colours. Keeping it separate forces that boundary to stay
clean, lets it pair with any simulation that exposes typed arrays, and
keeps the consuming app's graph-host adapter (selectors, classes, filters)
where it belongs, in the app.

## Decisions

- **One RGBA32F texture for `x, y, size, visible`** rather than instance
  attributes, because edges need to look up two arbitrary nodes per
  instance. Float textures are core WebGL2 for sampling with NEAREST.
- **Premultiplied alpha** throughout, `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`.
  Fill and border are composited inside the node shader.
- **Sizes in world units**, anti-aliasing in device pixels
  (`1 / pxPerWorld`), so zooming behaves like a canvas graph and edges stay
  crisp at any zoom.
- **Picking on the CPU** from the float32 mirror with a uniform grid,
  rebuilt lazily after positions change. Rebuilding 20k points is
  sub-millisecond; GPU picking would cost a readback.
- **Labels in the DOM** for a subset. The consuming app this was built for
  shows labels only on hover, selection and roots, which made GPU text the
  wrong first problem to solve.
- **Drag does not move nodes.** The simulation owns positions; the renderer
  reports.
- **Attributes a program does not use** get location -1 and must be
  skipped when binding; the marker program ignores `a_dash`.
- **`half` is reserved in GLSL ES** under ANGLE (WebKitGTK); found only by
  running in the real engine.

## Testing on the real engine

Playwright's WebKit is built against Ubuntu libraries and does not launch
on Arch. `test/webkitgtk/run.py` drives the system WebKitGTK through
PyGObject instead: an offscreen GTK window (X11 backend, Wayland's
offscreen window has no GL context) loads the demo, runs `checks.js`, and
parks the JSON result on `window` because `evaluate_javascript` cannot
return a Promise.
