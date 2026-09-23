// S0 spike for nemo-graph's GPU-layout CR (changes/2026-09-23-gpu-force-layout.md):
// a THROWAWAY WebGL2 force simulation — ping-pong RGBA32F textures, three
// grid levels for many-body (cosmos.gl's shape), CSR link gather, centre
// force, integrate. It exists to measure COST in WebKitGTK, not to lay out
// graphs well: level overlap is not corrected, bias is 0.5, no collide.
import { createProgram, TEX_WIDTH as W } from '../src/gl'

const VS_QUAD = `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }`

const VS_LEVEL = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D u_pos; uniform float u_space, u_grid;
out vec2 v_pos;
void main(){
  int i = gl_VertexID;
  vec2 p = texelFetch(u_pos, ivec2(i % ${W}, i / ${W}), 0).xy;
  vec2 c = clamp(floor((p / u_space * 0.5 + 0.5) * u_grid), 0.0, u_grid - 1.0);
  gl_Position = vec4((c + 0.5) / u_grid * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
  v_pos = p;
}`
const FS_LEVEL = `#version 300 es
precision highp float; in vec2 v_pos; out vec4 o;
void main(){ o = vec4(v_pos, 1.0, 0.0); }`   // blend ONE,ONE → (Σx, Σy, count)

const FS_VEL = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D u_pos, u_vel, u_linkOff, u_linkAdj, u_l0, u_l1, u_l2;
uniform int u_n; uniform float u_alpha, u_space, u_repel, u_center, u_decay, u_g0, u_g1, u_g2;
out vec4 o;
ivec2 tc(int i){ return ivec2(i % ${W}, i / ${W}); }
vec2 repelFrom(sampler2D lvl, float G, vec2 p, int win){
  vec2 c = clamp(floor((p / u_space * 0.5 + 0.5) * G), 0.0, G - 1.0);
  vec2 acc = vec2(0.0);
  for (int dy = -win; dy <= win; dy++) for (int dx = -win; dx <= win; dx++) {
    vec2 cc = c + vec2(float(dx), float(dy));
    if (cc.x < 0.0 || cc.y < 0.0 || cc.x >= G || cc.y >= G) continue;
    vec4 cell = texelFetch(lvl, ivec2(cc), 0);
    if (cell.z < 0.5) continue;
    vec2 d = p - cell.xy / cell.z;
    float l2 = dot(d, d) + 25.0;
    acc += d * (u_repel * cell.z * u_alpha / l2);
  }
  return acc;
}
void main(){
  int i = int(gl_FragCoord.y) * ${W} + int(gl_FragCoord.x);
  vec2 p = texelFetch(u_pos, tc(i), 0).xy;
  vec2 v = texelFetch(u_vel, tc(i), 0).xy;
  if (i >= u_n) { o = vec4(v, 0.0, 0.0); return; }
  v += repelFrom(u_l0, u_g0, p, 2) + repelFrom(u_l1, u_g1, p, 2) + repelFrom(u_l2, u_g2, p, 3);
  vec4 off = texelFetch(u_linkOff, tc(i), 0);
  int start = int(off.x), cnt = int(off.y);
  for (int k = 0; k < 32; k++) {
    if (k >= cnt) break;
    vec4 e = texelFetch(u_linkAdj, tc(start + k), 0);
    vec2 d = texelFetch(u_pos, tc(int(e.x)), 0).xy - p;
    float l = length(d) + 1e-6;
    v += d * ((l - e.y) / l * u_alpha * e.z * 0.5);
  }
  v -= p * u_center * u_alpha;
  o = vec4(v * u_decay, 0.0, 0.0);
}`
const FS_POS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D u_pos, u_vel; out vec4 o;
void main(){
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 p = texelFetch(u_pos, t, 0); vec2 v = texelFetch(u_vel, t, 0).xy;
  o = vec4(p.w > 0.5 ? p.xy : p.xy + v, p.zw);
}`

type Tex = { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number }
function makeTarget(gl: WebGL2RenderingContext, w: number, h: number, data: Float32Array | null): Tex {
  const tex = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data)
  const fb = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('float framebuffer incomplete: ' + status)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return { tex, fb, w, h }
}

export function randomGraph(n: number, seed = 1) {
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32
  const space = Math.sqrt(n) * 20
  const rows = Math.ceil(n / W)
  const pos = new Float32Array(W * rows * 4)
  for (let i = 0; i < n; i++) { pos[4 * i] = (rnd() * 2 - 1) * space; pos[4 * i + 1] = (rnd() * 2 - 1) * space }
  const adj: number[][] = Array.from({ length: n }, () => [])
  const link = (a: number, b: number) => { adj[a].push(b); adj[b].push(a) }
  for (let i = 1; i < n; i++) link(Math.floor(rnd() * i), i)
  for (let i = 0; i < n; i++) link(Math.floor(rnd() * n), Math.floor(rnd() * n))
  const off = new Float32Array(W * rows * 4)
  let total = 0; for (let i = 0; i < n; i++) total += Math.min(adj[i].length, 32)
  const adjRows = Math.ceil(total / W)
  const adjTex = new Float32Array(W * adjRows * 4)
  let k = 0
  for (let i = 0; i < n; i++) {
    off[4 * i] = k; off[4 * i + 1] = Math.min(adj[i].length, 32)
    for (const j of adj[i].slice(0, 32)) {
      const minDeg = Math.max(1, Math.min(adj[i].length, adj[j].length))
      adjTex[4 * k] = j; adjTex[4 * k + 1] = 80; adjTex[4 * k + 2] = 0.3 / minDeg; k++
    }
  }
  return { n, rows, space, pos, off, adjTex, adjRows, links: total / 2 }
}

export class GpuSim {
  gl: WebGL2RenderingContext
  n = 0; rows = 1; space = 1000; alpha = 1; alphaDecay = 0.015; ticks = 0
  pos!: [Tex, Tex]; vel!: [Tex, Tex]; linkOff!: Tex; linkAdj!: Tex; levels!: Tex[]
  grids = [64, 16, 4]
  pVel: WebGLProgram; pPos: WebGLProgram; pLevel: WebGLProgram
  ext: Record<string, boolean>
  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false })
    if (!gl) throw new Error('no webgl2')
    this.gl = gl
    this.ext = {
      EXT_color_buffer_float: !!gl.getExtension('EXT_color_buffer_float'),
      EXT_float_blend: !!gl.getExtension('EXT_float_blend'),
      EXT_disjoint_timer_query_webgl2: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
      OES_texture_float_linear: !!gl.getExtension('OES_texture_float_linear'),
    }
    this.pVel = createProgram(gl, VS_QUAD, FS_VEL)
    this.pPos = createProgram(gl, VS_QUAD, FS_POS)
    this.pLevel = createProgram(gl, VS_LEVEL, FS_LEVEL)
  }
  build(n: number) {
    const gl = this.gl
    const g = randomGraph(n)
    this.n = n; this.rows = g.rows; this.space = g.space; this.alpha = 1; this.ticks = 0
    this.pos = [makeTarget(gl, W, g.rows, g.pos), makeTarget(gl, W, g.rows, g.pos)]
    this.vel = [makeTarget(gl, W, g.rows, new Float32Array(W * g.rows * 4)), makeTarget(gl, W, g.rows, new Float32Array(W * g.rows * 4))]
    this.linkOff = makeTarget(gl, W, g.rows, g.off)
    this.linkAdj = makeTarget(gl, W, g.adjRows, g.adjTex)
    this.levels = this.grids.map((G) => makeTarget(gl, G, G, null))
    return g
  }
  private bind(unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) {
    const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(loc, unit)
  }
  tick() {
    const gl = this.gl
    // 1. level grids: splat every node into its cell with additive float blending
    gl.useProgram(this.pLevel)
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE)
    this.levels.forEach((lvl, li) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, lvl.fb); gl.viewport(0, 0, lvl.w, lvl.h)
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
      this.bind(0, this.pos[0].tex, gl.getUniformLocation(this.pLevel, 'u_pos'))
      gl.uniform1f(gl.getUniformLocation(this.pLevel, 'u_space'), this.space)
      gl.uniform1f(gl.getUniformLocation(this.pLevel, 'u_grid'), this.grids[li])
      gl.drawArrays(gl.POINTS, 0, this.n)
    })
    gl.disable(gl.BLEND)
    // 2. velocities
    gl.useProgram(this.pVel)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.vel[1].fb); gl.viewport(0, 0, W, this.rows)
    const u = (name: string) => gl.getUniformLocation(this.pVel, name)
    this.bind(0, this.pos[0].tex, u('u_pos')); this.bind(1, this.vel[0].tex, u('u_vel'))
    this.bind(2, this.linkOff.tex, u('u_linkOff')); this.bind(3, this.linkAdj.tex, u('u_linkAdj'))
    this.bind(4, this.levels[0].tex, u('u_l0')); this.bind(5, this.levels[1].tex, u('u_l1')); this.bind(6, this.levels[2].tex, u('u_l2'))
    gl.uniform1i(u('u_n'), this.n); gl.uniform1f(u('u_alpha'), this.alpha); gl.uniform1f(u('u_space'), this.space)
    gl.uniform1f(u('u_repel'), 150 / Math.max(Math.log(this.n + 1), 0.01)); gl.uniform1f(u('u_center'), 0.05); gl.uniform1f(u('u_decay'), 0.65)
    gl.uniform1f(u('u_g0'), this.grids[0]); gl.uniform1f(u('u_g1'), this.grids[1]); gl.uniform1f(u('u_g2'), this.grids[2])
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    // 3. positions
    gl.useProgram(this.pPos)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pos[1].fb); gl.viewport(0, 0, W, this.rows)
    this.bind(0, this.pos[0].tex, gl.getUniformLocation(this.pPos, 'u_pos')); this.bind(1, this.vel[1].tex, gl.getUniformLocation(this.pPos, 'u_vel'))
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.pos.reverse(); this.vel.reverse()
    this.alpha += (0 - this.alpha) * this.alphaDecay
    this.ticks++
  }
  /** Synchronous full readback of positions (upper bound; async PBO would hide most of it). */
  readback(): Float32Array {
    const gl = this.gl
    const out = new Float32Array(W * this.rows * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pos[0].fb)
    gl.readPixels(0, 0, W, this.rows, gl.RGBA, gl.FLOAT, out)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return out
  }
  finish() { this.gl.finish() }
}

const sim = new GpuSim(document.getElementById('c') as HTMLCanvasElement)
;(window as any).gpusim = { sim, W }
document.getElementById('hud')!.textContent = 'gpusim ready — ext: ' + JSON.stringify(sim.ext)
