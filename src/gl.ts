/** Small WebGL2 helpers. Errors are thrown with the shader log attached. */

export function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)
  if (!sh) throw new Error('createShader failed')
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error(`shader compile failed: ${log}\n${src}`)
  }
  return sh
}

export function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()
  if (!p) throw new Error('createProgram failed')
  const v = compileShader(gl, gl.VERTEX_SHADER, vs)
  const f = compileShader(gl, gl.FRAGMENT_SHADER, fs)
  gl.attachShader(p, v)
  gl.attachShader(p, f)
  gl.linkProgram(p)
  gl.deleteShader(v)
  gl.deleteShader(f)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p)
    gl.deleteProgram(p)
    throw new Error(`program link failed: ${log}`)
  }
  return p
}

/** Texture width used for index → texel mapping. Must match the shaders. */
export const TEX_WIDTH = 2048

/** A float RGBA texture holding one texel per node, addressed by index. */
export class NodeTexture {
  readonly tex: WebGLTexture
  private rows = 0
  private data = new Float32Array(0)

  constructor(private gl: WebGL2RenderingContext) {
    const tex = gl.createTexture()
    if (!tex) throw new Error('createTexture failed')
    this.tex = tex
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  /** (Re)allocate for `count` nodes. Returns the CPU-side staging array (4 floats per node). */
  allocate(count: number): Float32Array {
    const rows = Math.max(1, Math.ceil(count / TEX_WIDTH))
    if (rows !== this.rows) {
      this.rows = rows
      this.data = new Float32Array(TEX_WIDTH * rows * 4)
      const gl = this.gl
      gl.bindTexture(gl.TEXTURE_2D, this.tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEX_WIDTH, rows, 0, gl.RGBA, gl.FLOAT, null)
    }
    return this.data
  }

  get staging(): Float32Array {
    return this.data
  }

  /** Upload the staging array (all rows). */
  upload(): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_WIDTH, this.rows, gl.RGBA, gl.FLOAT, this.data)
  }

  destroy(): void {
    this.gl.deleteTexture(this.tex)
  }
}

/** An instance-attribute buffer with typed upload and divisor 1. */
export class InstanceBuffer {
  readonly buf: WebGLBuffer
  private capacity = 0

  constructor(private gl: WebGL2RenderingContext) {
    const b = gl.createBuffer()
    if (!b) throw new Error('createBuffer failed')
    this.buf = b
  }

  upload(data: ArrayBufferView): void {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    if (data.byteLength > this.capacity) {
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
      this.capacity = data.byteLength
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
    }
  }

  /** Bind as a float attribute (normalized for byte colours). */
  attrib(loc: number, size: number, type: number, normalized: boolean, byteOffset = 0): void {
    if (loc < 0) return // attribute optimised out of this program
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, size, type, normalized, 0, byteOffset)
    gl.vertexAttribDivisor(loc, 1)
  }

  /** Bind as an integer attribute. */
  attribI(loc: number, size: number, type: number, byteOffset = 0): void {
    if (loc < 0) return
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribIPointer(loc, size, type, 0, byteOffset)
    gl.vertexAttribDivisor(loc, 1)
  }

  destroy(): void {
    this.gl.deleteBuffer(this.buf)
  }
}
