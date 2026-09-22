// GLSL ES 3.00 sources. All programs read node data from one RGBA32F texture
// (x, y, size, visible) addressed by node index, so positions are uploaded
// once per tick and edges resolve their endpoints on the GPU.

const HEADER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_nodes;
uniform mat3 u_view;
uniform float u_pxPerWorld;
vec4 fetchNode(int i) { return texelFetch(u_nodes, ivec2(i & 2047, i >> 11), 0); }
const vec4 OFFSCREEN = vec4(2.0, 2.0, 2.0, 1.0);
`

export const NODE_VS = `${HEADER}
in vec2 a_corner;
in vec4 a_color;
in vec4 a_border;
in float a_borderWidth;
in uint a_shape;
in uint a_borderDash;
out vec2 v_p;
out vec4 v_color;
out vec4 v_border;
flat out float v_r;
flat out float v_bw;
flat out uint v_shape;
flat out uint v_dash;
void main() {
  vec4 nd = fetchNode(gl_InstanceID);
  if (nd.w < 0.5 || nd.z <= 0.0) { gl_Position = OFFSCREEN; return; }
  float pad = 1.5 / u_pxPerWorld;
  float ext = nd.z * 0.5 + a_borderWidth + pad;
  vec2 world = nd.xy + a_corner * ext;
  gl_Position = vec4((u_view * vec3(world, 1.0)).xy, 0.0, 1.0);
  v_p = a_corner * ext;
  v_r = nd.z * 0.5;
  v_bw = a_borderWidth;
  v_color = a_color;
  v_border = a_border;
  v_shape = a_shape;
  v_dash = a_borderDash;
}`

export const NODE_FS = `#version 300 es
precision highp float;
precision highp int;
uniform float u_pxPerWorld;
in vec2 v_p;
in vec4 v_color;
in vec4 v_border;
flat in float v_r;
flat in float v_bw;
flat in uint v_shape;
flat in uint v_dash;
out vec4 o;
float sd(vec2 p, float r, uint shape) {
  if (shape == 1u) { vec2 d = abs(p) - vec2(r); return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
  if (shape == 2u) { return ((abs(p.x) + abs(p.y)) - r) * 0.70710678; }
  if (shape == 3u) {
    const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
    p = abs(p);
    p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
    p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
    return length(p) * sign(p.y);
  }
  return length(p) - r;
}
void main() {
  float d = sd(v_p, v_r, v_shape);
  float aa = 1.0 / u_pxPerWorld;
  float fill = 1.0 - smoothstep(-aa, aa, d);
  float border = (1.0 - smoothstep(v_bw - aa, v_bw + aa, d)) * smoothstep(-aa, aa, d);
  if (v_dash == 1u && v_bw > 0.0) {
    float circ = 6.2831853 * (v_r + v_bw * 0.5) * u_pxPerWorld;
    float n = max(4.0, floor(circ / 10.0));
    float ang = atan(v_p.y, v_p.x) / 6.2831853 + 0.5;
    border *= step(fract(ang * n), 0.6);
  }
  vec4 f = vec4(v_color.rgb * v_color.a, v_color.a) * fill;
  vec4 b = vec4(v_border.rgb * v_border.a, v_border.a) * border;
  o = f + b * (1.0 - f.a);
}`

// Shared by the edge body and the marker programs.
const EDGE_COMMON = `
in vec2 a_corner;
in uvec2 a_ends;
in vec4 a_color;
in float a_width;
in uint a_arrow;
in uint a_dash;
float arrowLen(float w, uint arrow) { return (arrow & 1u) != 0u ? max(w * 3.0, 4.0) : 0.0; }
float circleR(float w, uint arrow) { return (arrow & 2u) != 0u ? max(w * 1.5, 2.0) : 0.0; }
`

export const EDGE_VS = `${HEADER}${EDGE_COMMON}
out vec2 v_ps;
out vec4 v_color;
flat out float v_halfw;
flat out uint v_dash;
void main() {
  vec4 s = fetchNode(int(a_ends.x));
  vec4 t = fetchNode(int(a_ends.y));
  vec2 d = t.xy - s.xy;
  float len = length(d);
  if (s.w < 0.5 || t.w < 0.5 || len < 1e-6 || a_width <= 0.0) { gl_Position = OFFSCREEN; return; }
  vec2 dir = d / len;
  vec2 nrm = vec2(-dir.y, dir.x);
  float rs = s.z * 0.5 + circleR(a_width, a_arrow) * 2.0;
  float rt = t.z * 0.5 + arrowLen(a_width, a_arrow);
  float L = max(len - rs - rt, 0.0);
  vec2 p0 = s.xy + dir * rs;
  float pad = 1.0 / u_pxPerWorld;
  float hw = a_width * 0.5 + pad;
  vec2 world = p0 + dir * (a_corner.x * L) + nrm * (a_corner.y * hw);
  gl_Position = vec4((u_view * vec3(world, 1.0)).xy, 0.0, 1.0);
  v_ps = vec2(a_corner.x * L * u_pxPerWorld, a_corner.y * hw);
  v_halfw = a_width * 0.5;
  v_color = a_color;
  v_dash = a_dash;
}`

export const EDGE_FS = `#version 300 es
precision highp float;
precision highp int;
uniform float u_pxPerWorld;
in vec2 v_ps;
in vec4 v_color;
flat in float v_halfw;
flat in uint v_dash;
out vec4 o;
void main() {
  float aa = 1.0 / u_pxPerWorld;
  float a = 1.0 - smoothstep(v_halfw - aa, v_halfw + aa, abs(v_ps.y));
  if (v_dash == 1u) a *= step(fract(v_ps.x / 12.0), 0.66);
  else if (v_dash == 2u) { float p = max(v_halfw * 4.0 * u_pxPerWorld, 3.0); a *= step(fract(v_ps.x / p), 0.5); }
  o = vec4(v_color.rgb * v_color.a, v_color.a) * a;
}`

// Markers: u_end 0 = source circle, 1 = target triangle. One quad per edge.
export const MARKER_VS = `${HEADER}${EDGE_COMMON}
uniform int u_end;
out vec2 v_q;
out vec4 v_color;
flat out float v_ext;
void main() {
  vec4 s = fetchNode(int(a_ends.x));
  vec4 t = fetchNode(int(a_ends.y));
  vec2 d = t.xy - s.xy;
  float len = length(d);
  float al = arrowLen(a_width, a_arrow);
  float cr = circleR(a_width, a_arrow);
  float ext = u_end == 1 ? al * 0.5 : cr;
  if (s.w < 0.5 || t.w < 0.5 || len < 1e-6 || ext <= 0.0) { gl_Position = OFFSCREEN; return; }
  vec2 dir = d / len;
  vec2 nrm = vec2(-dir.y, dir.x);
  vec2 centre = u_end == 1 ? t.xy - dir * (t.z * 0.5 + al * 0.5) : s.xy + dir * (s.z * 0.5 + cr);
  float pad = 1.0 / u_pxPerWorld;
  vec2 world = centre + dir * (a_corner.x * (ext + pad)) + nrm * (a_corner.y * (ext + pad));
  gl_Position = vec4((u_view * vec3(world, 1.0)).xy, 0.0, 1.0);
  v_q = a_corner * (ext + pad);
  v_ext = ext;
  v_color = a_color;
}`

export const MARKER_FS = `#version 300 es
precision highp float;
precision highp int;
uniform float u_pxPerWorld;
uniform int u_end;
in vec2 v_q;
in vec4 v_color;
flat in float v_ext;
out vec4 o;
void main() {
  float aa = 1.0 / u_pxPerWorld;
  float d;
  if (u_end == 1) {
    // triangle: apex at +x, base at -x spanning |y| <= 0.7 ext
    float slope = 0.7;
    float edge = (abs(v_q.y) - slope * (v_ext - v_q.x)) / sqrt(1.0 + slope * slope);
    d = max(edge, -v_ext - v_q.x);
  } else {
    d = length(v_q) - v_ext;
  }
  float a = 1.0 - smoothstep(-aa, aa, d);
  o = vec4(v_color.rgb * v_color.a, v_color.a) * a;
}`
