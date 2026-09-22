/** Node shapes, by index into the `shape` style array. */
export const Shape = { circle: 0, rect: 1, diamond: 2, hexagon: 3 } as const
export type ShapeId = (typeof Shape)[keyof typeof Shape]

/** Line dash patterns for edges and node borders. */
export const Dash = { solid: 0, dashed: 1, dotted: 2 } as const
export type DashId = (typeof Dash)[keyof typeof Dash]

/** Edge end markers, as bit flags in the `arrow` style array. */
export const Arrow = { none: 0, targetTriangle: 1, sourceCircle: 2 } as const

export interface GraphInput {
  nodeCount: number
  /** Endpoint pairs `[s0, t0, s1, t1, …]` as node indices. Self-loops are not drawn. */
  edges: Uint32Array | number[]
  /** Fan out edges that share a node pair as quadratic curves. Default true. */
  curveParallel?: boolean
}

/** Per-node style, one entry per node. Every field is optional on update; omitted fields keep their values. */
export interface NodeStyle {
  /** Diameter (or side) in world units. */
  size?: Float32Array
  /** RGBA, 4 bytes per node. Alpha applies to fill and border. */
  color?: Uint8Array
  shape?: Uint8Array
  /** Border width in world units, drawn outward from the shape edge. */
  borderWidth?: Float32Array
  borderColor?: Uint8Array
  borderDash?: Uint8Array
}

/** Per-edge style, one entry per edge. */
export interface EdgeStyle {
  color?: Uint8Array
  /** Line width in world units. */
  width?: Float32Array
  arrow?: Uint8Array
  dash?: Uint8Array
}

export interface RendererOptions {
  /** Clear colour, RGBA in 0..1. Default transparent black. */
  background?: [number, number, number, number]
  /** Defaults to `window.devicePixelRatio`. */
  devicePixelRatio?: number
  minZoom?: number
  maxZoom?: number
  /** Zoom multiplier per wheel notch. Default 1.1. */
  wheelZoomFactor?: number
  /** Sideways spacing between parallel edges, world units. Default 16. */
  parallelSpacing?: number
}

export interface PointerInfo {
  /** Node under the pointer, or -1. */
  node: number
  /** Edge under the pointer when no node is, else -1. */
  edge: number
  /** Endpoints of `edge`, or -1. */
  source: number
  target: number
  /** World coordinates. */
  x: number
  y: number
  /** CSS pixel coordinates relative to the canvas. */
  clientX: number
  clientY: number
  originalEvent: PointerEvent | MouseEvent | WheelEvent
}

export interface EventMap {
  hover: PointerInfo
  click: PointerInfo
  dblclick: PointerInfo
  contextmenu: PointerInfo
  dragstart: PointerInfo
  drag: PointerInfo
  dragend: PointerInfo
  viewport: { zoom: number; x: number; y: number }
  render: { frameMs: number }
}

export interface LabelEntry {
  node: number
  text: string
  className?: string
}

export interface BBox {
  x0: number
  y0: number
  x1: number
  y1: number
}
