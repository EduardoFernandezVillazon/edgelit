import { InstanceBuffer, createProgram } from './gl'
import { EDGE_FS, EDGE_VS, MARKER_FS, MARKER_VS, NODE_FS, NODE_VS } from './shaders'
import type { EdgeStyle, NodeStyle } from './types'

/** One shared unit quad (triangle strip) used as the per-vertex geometry of every instanced program. */
export function quadBuffer(gl: WebGL2RenderingContext, corners: Float32Array): WebGLBuffer {
  const b = gl.createBuffer()
  if (!b) throw new Error('createBuffer failed')
  gl.bindBuffer(gl.ARRAY_BUFFER, b)
  gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW)
  return b
}

const CENTRED_QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])
const EDGE_QUAD = new Float32Array([0, -1, 1, -1, 0, 1, 1, 1])

interface Uniforms {
  u_nodes: WebGLUniformLocation | null
  u_view: WebGLUniformLocation | null
  u_pxPerWorld: WebGLUniformLocation | null
  u_end?: WebGLUniformLocation | null
}

function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram): Uniforms {
  return {
    u_nodes: gl.getUniformLocation(p, 'u_nodes'),
    u_view: gl.getUniformLocation(p, 'u_view'),
    u_pxPerWorld: gl.getUniformLocation(p, 'u_pxPerWorld'),
    u_end: gl.getUniformLocation(p, 'u_end'),
  }
}

function bindCommon(gl: WebGL2RenderingContext, u: Uniforms, view: Float32Array, pxPerWorld: number, tex: WebGLTexture): void {
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.uniform1i(u.u_nodes, 0)
  gl.uniformMatrix3fv(u.u_view, false, view)
  gl.uniform1f(u.u_pxPerWorld, pxPerWorld)
}

export class NodeProgram {
  private program: WebGLProgram
  private vao: WebGLVertexArrayObject
  private u: Uniforms
  private color: InstanceBuffer
  private border: InstanceBuffer
  private borderWidth: InstanceBuffer
  private shape: InstanceBuffer
  private borderDash: InstanceBuffer
  private count = 0

  constructor(private gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, NODE_VS, NODE_FS)
    this.u = uniforms(gl, this.program)
    const vao = gl.createVertexArray()
    if (!vao) throw new Error('createVertexArray failed')
    this.vao = vao
    gl.bindVertexArray(vao)
    const corner = gl.getAttribLocation(this.program, 'a_corner')
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer(gl, CENTRED_QUAD))
    gl.enableVertexAttribArray(corner)
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0)
    this.color = new InstanceBuffer(gl)
    this.border = new InstanceBuffer(gl)
    this.borderWidth = new InstanceBuffer(gl)
    this.shape = new InstanceBuffer(gl)
    this.borderDash = new InstanceBuffer(gl)
    gl.bindVertexArray(null)
  }

  private loc(name: string): number {
    return this.gl.getAttribLocation(this.program, name)
  }

  /** Allocate defaults for `n` nodes. */
  reset(n: number, style: Required<NodeStyle>): void {
    this.count = n
    this.setStyle(style)
  }

  setStyle(s: NodeStyle): void {
    const gl = this.gl
    gl.bindVertexArray(this.vao)
    if (s.color) { this.color.upload(s.color); this.color.attrib(this.loc('a_color'), 4, gl.UNSIGNED_BYTE, true) }
    if (s.borderColor) { this.border.upload(s.borderColor); this.border.attrib(this.loc('a_border'), 4, gl.UNSIGNED_BYTE, true) }
    if (s.borderWidth) { this.borderWidth.upload(s.borderWidth); this.borderWidth.attrib(this.loc('a_borderWidth'), 1, gl.FLOAT, false) }
    if (s.shape) { this.shape.upload(s.shape); this.shape.attribI(this.loc('a_shape'), 1, gl.UNSIGNED_BYTE) }
    if (s.borderDash) { this.borderDash.upload(s.borderDash); this.borderDash.attribI(this.loc('a_borderDash'), 1, gl.UNSIGNED_BYTE) }
    gl.bindVertexArray(null)
  }

  draw(view: Float32Array, pxPerWorld: number, tex: WebGLTexture): void {
    if (this.count === 0) return
    const gl = this.gl
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    bindCommon(gl, this.u, view, pxPerWorld, tex)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count)
    gl.bindVertexArray(null)
  }

  destroy(): void {
    const gl = this.gl
    gl.deleteProgram(this.program)
    gl.deleteVertexArray(this.vao)
    for (const b of [this.color, this.border, this.borderWidth, this.shape, this.borderDash]) b.destroy()
  }
}

export class EdgeProgram {
  private body: WebGLProgram
  private marker: WebGLProgram
  private bodyVao: WebGLVertexArrayObject
  private markerVao: WebGLVertexArrayObject
  private ub: Uniforms
  private um: Uniforms
  private ends: InstanceBuffer
  private color: InstanceBuffer
  private width: InstanceBuffer
  private arrow: InstanceBuffer
  private dash: InstanceBuffer
  private count = 0
  private hasMarkers = false

  constructor(private gl: WebGL2RenderingContext) {
    this.body = createProgram(gl, EDGE_VS, EDGE_FS)
    this.marker = createProgram(gl, MARKER_VS, MARKER_FS)
    this.ub = uniforms(gl, this.body)
    this.um = uniforms(gl, this.marker)
    this.ends = new InstanceBuffer(gl)
    this.color = new InstanceBuffer(gl)
    this.width = new InstanceBuffer(gl)
    this.arrow = new InstanceBuffer(gl)
    this.dash = new InstanceBuffer(gl)
    this.bodyVao = this.makeVao(this.body, EDGE_QUAD)
    this.markerVao = this.makeVao(this.marker, CENTRED_QUAD)
  }

  private makeVao(program: WebGLProgram, quad: Float32Array): WebGLVertexArrayObject {
    const gl = this.gl
    const vao = gl.createVertexArray()
    if (!vao) throw new Error('createVertexArray failed')
    gl.bindVertexArray(vao)
    const corner = gl.getAttribLocation(program, 'a_corner')
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer(gl, quad))
    gl.enableVertexAttribArray(corner)
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    return vao
  }

  private bindAll(program: WebGLProgram, vao: WebGLVertexArrayObject, s: EdgeStyle, ends?: Uint32Array<ArrayBufferLike>): void {
    const gl = this.gl
    gl.bindVertexArray(vao)
    const loc = (n: string) => gl.getAttribLocation(program, n)
    if (ends) this.ends.attribI(loc('a_ends'), 2, gl.UNSIGNED_INT)
    if (s.color) this.color.attrib(loc('a_color'), 4, gl.UNSIGNED_BYTE, true)
    if (s.width) this.width.attrib(loc('a_width'), 1, gl.FLOAT, false)
    if (s.arrow) this.arrow.attribI(loc('a_arrow'), 1, gl.UNSIGNED_BYTE)
    if (s.dash) this.dash.attribI(loc('a_dash'), 1, gl.UNSIGNED_BYTE)
    gl.bindVertexArray(null)
  }

  reset(ends: Uint32Array<ArrayBufferLike>, style: Required<EdgeStyle>): void {
    this.count = ends.length / 2
    this.ends.upload(ends)
    this.setStyle(style, ends)
  }

  setStyle(s: EdgeStyle, ends?: Uint32Array<ArrayBufferLike>): void {
    if (s.color) this.color.upload(s.color)
    if (s.width) this.width.upload(s.width)
    if (s.arrow) {
      this.arrow.upload(s.arrow)
      this.hasMarkers = s.arrow.some((v) => v !== 0)
    }
    if (s.dash) this.dash.upload(s.dash)
    this.bindAll(this.body, this.bodyVao, s, ends)
    this.bindAll(this.marker, this.markerVao, s, ends)
  }

  draw(view: Float32Array, pxPerWorld: number, tex: WebGLTexture): void {
    if (this.count === 0) return
    const gl = this.gl
    gl.useProgram(this.body)
    gl.bindVertexArray(this.bodyVao)
    bindCommon(gl, this.ub, view, pxPerWorld, tex)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count)
    if (this.hasMarkers) {
      gl.useProgram(this.marker)
      gl.bindVertexArray(this.markerVao)
      bindCommon(gl, this.um, view, pxPerWorld, tex)
      gl.uniform1i(this.um.u_end ?? null, 1)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count)
      gl.uniform1i(this.um.u_end ?? null, 0)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count)
    }
    gl.bindVertexArray(null)
  }

  destroy(): void {
    const gl = this.gl
    gl.deleteProgram(this.body)
    gl.deleteProgram(this.marker)
    gl.deleteVertexArray(this.bodyVao)
    gl.deleteVertexArray(this.markerVao)
    for (const b of [this.ends, this.color, this.width, this.arrow, this.dash]) b.destroy()
  }
}
