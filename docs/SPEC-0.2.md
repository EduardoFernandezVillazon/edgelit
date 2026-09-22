# edgelit 0.2 specification

Agreed 2026-09-22. Implemented the same day; see DESIGN.md for what changed in the doing (two draw ranges, best-of-ten timing). Scope: the two 0.1 limits that matter for the first
consumer (nemo-graph), decided as follows. Labels stay DOM-only, below the
node. Self-loops and touch gestures are out of scope. 0.2 ships before
nemo's integration CR, so the consumer never sees the 0.1 straight-line
rendering of bidirectional pairs.

## 1. Curved parallel edges

### Behaviour

- Edges that share the same **unordered** node pair are fanned apart with
  quadratic curves; every other edge stays straight. This matches cytoscape's
  `bezier` default, which nemo relies on for opposite-direction pairs.
- Within a group of `k` parallel edges, edge `j` (in input order) gets a
  sideways offset of `(j - (k - 1) / 2) * parallelSpacing` world units at
  its midpoint. For `k = 2` the two edges bend symmetrically either side of
  the chord; for odd `k` the middle one is straight.
- Offsets are defined relative to the pair's canonical orientation (lower
  index → higher index), so an A→B and a B→A edge land on opposite sides
  instead of coinciding.
- Arrows and source markers follow the curve's tangent at the endpoint.
  Dash and dot patterns follow arc length, not chord length.
- Self-loops (`source === target`) are not drawn.

### API

- `RendererOptions.parallelSpacing?: number` — world units, default 16.
- `GraphInput.curveParallel?: boolean` — default true; false draws every
  edge straight (0.1 behaviour).
- No public per-edge curvature array in 0.2. The internal offset array is
  computed in `setGraph`; exposing it is a later, additive change.

### Implementation

- `setGraph` groups edges by `min(s,t) * n + max(s,t)` (a `Map` or a sort),
  assigns offsets into a `Float32Array(edgeCount)` and uploads it as an
  instance attribute `a_offset`.
- The edge body becomes a tessellated strip: `SEG = 12` segments per
  instance, `2 * (SEG + 1)` vertices, `gl_VertexID` giving `t` and the side.
  Control point `P1 = mid + normal * 2 * offset` (a quadratic passes through
  half the control offset at `t = 0.5`). For `offset == 0` the curve is the
  chord; one draw call serves both.
- Endpoint shortening by node radius (and arrow length) happens in `t`
  space: `t0 = r_s / L`, `t1 = 1 - (r_t + arrowLen) / L` with `L` the
  chord; good enough at the curvatures fan-out produces.
- Arc length for dashes: the vertex shader accumulates chord lengths of the
  segments up to its own `t` (a loop of at most `SEG` steps).
- The marker program evaluates the same curve at `t1` (target) or `t0`
  (source) and orients along the tangent `B'(t)`.
- Cost: 25 000 edges × 26 vertices ≈ 650 k vertices per frame, well inside
  budget; measured in the WebKitGTK harness as part of acceptance.

## 2. Edge picking and events

### Behaviour

- Every pointer event that reports a node also reports an edge: `hover`,
  `click`, `dblclick`, `contextmenu`. Nodes take precedence: when the pointer
  is over a node, `edge` is `-1`.
- `PointerInfo` gains `edge: number` (index or `-1`) and, when an edge is
  hit, `source` and `target` node indices, so a consumer can restyle and
  label both endpoints on click without a lookup (nemo's chosen behaviour:
  highlight and name both connected nodes).
- `hover` fires when the hovered node **or** edge changes.
- Dragging never starts on an edge; a press on an edge pans.
- Hit test tolerance: half the edge width plus 3 CSS px, in world units at
  the current zoom.
- `pickEdge(clientX, clientY)` is public, like `pick`.

### Implementation

- A second uniform grid over edge bounding boxes (chord box expanded by
  `|offset|`), rebuilt lazily when positions changed and a pick is
  requested. Hover picking is already throttled to one per frame, so during
  a live simulation this is one O(E) rebuild per frame at most (about 1 ms
  at 25 k edges).
- Candidate edges from the cell under the pointer (and its neighbours
  within the tolerance) are tested by point-to-polyline distance on the
  quadratic sampled at 8 points; straight edges use the exact segment
  distance. Hidden endpoints exclude the edge.
- Nearest edge wins on ties.

## 3. Unchanged in 0.2

- Labels: DOM overlay for a caller-chosen subset, centred below the node.
  Neither automatic reveal nor GPU text.
- No touch gestures; pointer and wheel only.
- Drag still reports and never moves nodes.

## Acceptance

1. Two edges A→B and B→A render as two visibly separate curves with
   arrows at both nodes; three parallel edges render as straight middle
   plus two symmetric curves (pixel checks in Chromium and WebKitGTK).
2. Dashed curved edges show a regular pattern along the curve.
3. `pickEdge` hits an edge between two isolated nodes at its midpoint and
   misses 10 px to the side; a node over an edge wins.
4. Hover fires on entering and leaving an edge; click on an edge carries
   `edge`, `source`, `target`.
5. 20 k nodes / 25 k edges (with roughly 5 % parallel pairs) still draw in
   under 8 ms per frame including GPU sync in the WebKitGTK harness.
6. Unit tests: parallel grouping and offset assignment, arc-length
   sampling helper, edge distance function.
7. README and `index.d.ts` document the new fields; version 0.2.0.
