// Minimal typings for forcefield-sim (the package ships plain JS).
declare module 'forcefield-sim' {
  export class Simulation {
    constructor(wasm: unknown, nodes?: object[])
    nodes(): Array<Record<string, unknown> & { x: number; y: number; vx: number; vy: number; fx?: number | null; fy?: number | null; index: number }>
    force(name: string, force?: unknown): Simulation
    alpha(): number
    alphaMin(): number
    alphaDecay(v?: number): Simulation
    velocityDecay(v?: number): Simulation
    tick(n?: number): Simulation
    views(): { pos: Float64Array; vel: Float64Array; fix: Float64Array }
  }
  /** Chainable d3-style force descriptor; every setter returns the descriptor. */
  export type ForceDescriptor = { [method: string]: (...args: any[]) => ForceDescriptor }
  export function forceLink(links: object[]): ForceDescriptor
  export function forceManyBody(): ForceDescriptor
  export function forceCollide(radius?: number): ForceDescriptor
  export function forceX(x?: number): ForceDescriptor
  export function forceY(y?: number): ForceDescriptor
  export function forceCenter(x?: number, y?: number): ForceDescriptor
  export function forceRadial(radius: number, x?: number, y?: number): ForceDescriptor
}
declare module 'forcefield-sim/worker' {
  export function serve(opts: {
    wasm: () => Promise<unknown>
    setup?: (sim: import('forcefield-sim').Simulation, payload: unknown, ctx: { links: object[] }) => void
    port?: unknown
  }): { readonly simulation: unknown }
}
declare module 'forcefield-sim/client' {
  export class SimulationClient {
    constructor(worker: Worker, opts?: { buffers?: number })
    tick: number
    alpha: number
    n: number
    onFrame(fn: (pos: Float32Array, meta: { tick: number; alpha: number }) => void): this
    on(type: string, fn: ((...args: unknown[]) => void) | null): this
    init(spec: { nodes: object[]; links?: object[]; payload?: unknown; keepPositions?: boolean; running?: boolean }): Promise<number>
    setup(payload: unknown): void
    call(method: string, ...args: unknown[]): Promise<unknown>
    send(method: string, ...args: unknown[]): this
    alphaTarget(v: number): this
    alphaDecay(v: number): this
    run(running: boolean): this
    restart(): this
    stop(): this
    setFixed(node: number, x: number, y: number): this
    setPosition(node: number, x: number, y: number): this
    step(iterations?: number): this
    terminate(): void
  }
}
