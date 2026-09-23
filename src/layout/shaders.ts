// GLSL for the GPU force layout (nemo-graph changes/2026-09-23-gpu-force-layout.md,
// design in docs/architecture/cosmos-review.md there). Every pass is a
// fragment shader over one texel per node (or one vertex per node for the
// splats). `W` is the node-texture width shared with the renderer.
import { TEX_WIDTH as W } from '../gl'

export const VS_QUAD = `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }`

const COMMON = `
precision highp float; precision highp int; precision highp sampler2D;
const int W = ${W};
ivec2 tc(int i){ return ivec2(i % W, i / W); }
// cell of a position at a grid of G cells per axis over [-space, space]
vec2 cellOf(vec2 p, float space, float G){ return clamp(floor((p / space * 0.5 + 0.5) * G), 0.0, G - 1.0); }
`

/** Splat every live node into its cell as (x, y, 1) with additive blending. */
export const VS_SPLAT = `#version 300 es
${COMMON}
uniform sampler2D u_pos; uniform float u_space, u_grid; uniform int u_n;
out vec2 v_pos;
void main(){
  int i = gl_VertexID;
  vec4 p = texelFetch(u_pos, tc(i), 0);
  // Absent nodes (z < 0) must not enter the grid: a NaN or stray position
  // poisons its whole cell under additive blending.
  if (i >= u_n || p.z < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; v_pos = vec2(0.0); return; }
  vec2 c = cellOf(p.xy, u_space, u_grid);
  gl_Position = vec4((c + 0.5) / u_grid * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
  v_pos = p.xy;
}`
export const FS_SPLAT = `#version 300 es
precision highp float; in vec2 v_pos; out vec4 o;
void main(){ o = vec4(v_pos, 1.0, 0.0); }`

/**
 * Depth-peeled near-field slots (cosmos.gl's near field): pass k keeps, per
 * finest cell, the live node with the smallest per-tick hash that is larger
 * than pass k-1's winner. The depth test does the min; the previous slot
 * texture does the "larger than". Output (index, hash); empty = (-1, 2).
 */
export const VS_SLOT = `#version 300 es
${COMMON}
uniform sampler2D u_pos, u_prev; uniform float u_space, u_grid, u_seed; uniform int u_n, u_hasPrev;
flat out float v_index; flat out float v_hash;
float hash(float i){ return fract(sin(i * 12.9898 + u_seed * 78.233) * 43758.5453); }
void main(){
  int i = gl_VertexID;
  vec4 p = texelFetch(u_pos, tc(i), 0);
  float h = hash(float(i));
  vec2 c = cellOf(p.xy, u_space, u_grid);
  bool cull = i >= u_n || p.z < 0.0;
  if (u_hasPrev == 1) { vec4 prev = texelFetch(u_prev, ivec2(c), 0); if (h <= prev.y) cull = true; }
  if (cull) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; v_index = -1.0; v_hash = 2.0; return; }
  gl_Position = vec4((c + 0.5) / u_grid * 2.0 - 1.0, h * 2.0 - 1.0, 1.0);
  gl_PointSize = 1.0;
  v_index = float(i); v_hash = h;
}`
export const FS_SLOT = `#version 300 es
precision highp float; flat in float v_index; flat in float v_hash; out vec4 o;
void main(){ o = vec4(v_index, v_hash, 0.0, 0.0); }`

/** Copy x, y into an external RGBA32F texture; the caller masks colour writes to R, G. */
export const FS_BLIT = `#version 300 es
${COMMON}
uniform sampler2D u_pos; out vec4 o;
void main(){ o = vec4(texelFetch(u_pos, ivec2(gl_FragCoord.xy), 0).xy, 0.0, 0.0); }`

/**
 * The velocity pass: far field from the level grids with the exclusion shell,
 * near field from the depth-peeled slots (pairwise, unbiased, collide rides
 * along), links + DAG pairs from the CSR adjacency, per-node centring.
 */
export const FS_VEL = `#version 300 es
${COMMON}
#define MAX_LEVELS 8
#define MAX_SLOTS 8
uniform sampler2D u_pos, u_vel, u_attr, u_adjOff, u_adj;
uniform sampler2D u_level[MAX_LEVELS];
uniform sampler2D u_slot[MAX_SLOTS];
uniform int u_n, u_levels, u_slots, u_maxDeg;
uniform float u_alpha, u_space, u_repel, u_distMin2, u_distMax2, u_collideR, u_collideStrength, u_dagGap, u_dagStrength, u_decay;
uniform float u_grid[MAX_LEVELS];   // cells per axis, level 0 = finest
out vec4 o;

vec4 levelAt(int l, ivec2 c){
  // sampler arrays need constant indices in GLSL ES 3.00
  if (l == 0) return texelFetch(u_level[0], c, 0);
  if (l == 1) return texelFetch(u_level[1], c, 0);
  if (l == 2) return texelFetch(u_level[2], c, 0);
  if (l == 3) return texelFetch(u_level[3], c, 0);
  if (l == 4) return texelFetch(u_level[4], c, 0);
  if (l == 5) return texelFetch(u_level[5], c, 0);
  if (l == 6) return texelFetch(u_level[6], c, 0);
  return texelFetch(u_level[7], c, 0);
}
vec4 slotAt(int k, ivec2 c){
  if (k == 0) return texelFetch(u_slot[0], c, 0);
  if (k == 1) return texelFetch(u_slot[1], c, 0);
  if (k == 2) return texelFetch(u_slot[2], c, 0);
  if (k == 3) return texelFetch(u_slot[3], c, 0);
  if (k == 4) return texelFetch(u_slot[4], c, 0);
  if (k == 5) return texelFetch(u_slot[5], c, 0);
  if (k == 6) return texelFetch(u_slot[6], c, 0);
  return texelFetch(u_slot[7], c, 0);
}
// d3 many-body pairwise term from a mass at q onto p (clamped inverse distance)
vec2 repelTerm(vec2 p, vec2 q, float mass){
  vec2 d = p - q;
  float l2 = max(dot(d, d), 1e-6);
  if (l2 > u_distMax2) return vec2(0.0);
  l2 = max(l2, u_distMin2);
  return d * (u_repel * mass * u_alpha / l2);
}

void main(){
  int i = int(gl_FragCoord.y) * W + int(gl_FragCoord.x);
  vec4 pv = texelFetch(u_pos, tc(i), 0);
  vec2 p = pv.xy;
  vec2 v = texelFetch(u_vel, tc(i), 0).xy;
  if (i >= u_n || pv.z < 0.0) { o = vec4(0.0); return; }
  vec4 attr = texelFetch(u_attr, tc(i), 0);   // x: centre strength, y: radius

  // --- far field: each level covers the 6x6 block under the coarser level's
  // 3x3, minus this level's own 3x3 (cosmos.gl's exclusion shell); the
  // coarsest level covers the whole grid minus its 3x3.
  for (int l = 0; l < MAX_LEVELS; l++) {
    if (l >= u_levels) break;
    float G = u_grid[l];
    vec2 c = cellOf(p, u_space, G);
    ivec2 ci = ivec2(c);
    int lo_x, hi_x, lo_y, hi_y;
    if (l == u_levels - 1) { lo_x = 0; hi_x = int(G) - 1; lo_y = 0; hi_y = int(G) - 1; }
    else {
      ivec2 parent = ci / 2;
      lo_x = (parent.x - 1) * 2; hi_x = (parent.x + 1) * 2 + 1;
      lo_y = (parent.y - 1) * 2; hi_y = (parent.y + 1) * 2 + 1;
    }
    for (int y = lo_y; y <= hi_y; y++) {
      if (y < 0 || y >= int(G)) continue;
      for (int x = lo_x; x <= hi_x; x++) {
        if (x < 0 || x >= int(G)) continue;
        if (abs(x - ci.x) <= 1 && abs(y - ci.y) <= 1) continue;   // the shell the next level refines
        vec4 cell = levelAt(l, ivec2(x, y));
        if (cell.z < 0.5) continue;
        v += repelTerm(p, cell.xy / cell.z, cell.z);
      }
    }
  }

  // --- near field: the finest 3x3, pairwise from up to u_slots sampled nodes
  // per cell, each weighted by count/sampled so the expectation is exact.
  {
    float G = u_grid[0];
    ivec2 ci = ivec2(cellOf(p, u_space, G));
    for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
      ivec2 c = ci + ivec2(dx, dy);
      if (c.x < 0 || c.y < 0 || c.x >= int(G) || c.y >= int(G)) continue;
      float cnt = levelAt(0, c).z;
      if (dx == 0 && dy == 0) cnt -= 1.0;   // exclude self from the count
      if (cnt < 0.5) continue;
      vec2 acc = vec2(0.0); float sampled = 0.0;
      for (int k = 0; k < MAX_SLOTS; k++) {
        if (k >= u_slots) break;
        vec4 s = slotAt(k, c);
        int j = int(s.x);
        if (j < 0) break;
        if (j == i) continue;
        vec4 q = texelFetch(u_pos, tc(j), 0);
        sampled += 1.0;
        acc += repelTerm(p, q.xy, 1.0);
        // collide (d3-style, on velocity): overlap pushes apart
        float rj = texelFetch(u_attr, tc(j), 0).y;
        vec2 d = p - q.xy; float l = length(d) + 1e-6; float r = attr.y + rj;
        if (l < r) v += d / l * ((r - l) * u_collideStrength * 0.5);
      }
      if (sampled > 0.5) v += acc * (cnt / sampled);
    }
  }

  // --- links and DAG pairs (CSR; kind 0 link, 1 = I am the left of a pair, 2 = the right)
  {
    vec4 off = texelFetch(u_adjOff, tc(i), 0);
    int start = int(off.x), cnt = int(off.y);
    for (int k = 0; k < 64; k++) {
      if (k >= cnt || k >= u_maxDeg) break;
      vec4 e = texelFetch(u_adj, tc(start + k), 0);
      vec2 q = texelFetch(u_pos, tc(int(e.x)), 0).xy;
      int kind = int(e.w);
      if (kind == 0) {
        vec2 d = q - p; float l = length(d) + 1e-6;
        v += d * ((l - e.y) / l * u_alpha * e.z * 0.5);
      } else {
        float shortfall = kind == 1 ? u_dagGap - (q.x - p.x) : u_dagGap - (p.x - q.x);
        if (shortfall > 0.0) v.x += (kind == 1 ? -1.0 : 1.0) * shortfall * u_dagStrength * u_alpha * 0.5;
      }
    }
  }

  // --- centring (per-node strength: depth centring)
  v -= p * attr.x * u_alpha;
  o = vec4(v * u_decay, 0.0, 0.0);
}`

export const FS_POS = `#version 300 es
${COMMON}
uniform sampler2D u_pos, u_vel; uniform float u_space; out vec4 o;
void main(){
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 p = texelFetch(u_pos, t, 0); vec2 v = texelFetch(u_vel, t, 0).xy;
  vec2 np = p.w > 0.5 ? p.xy : clamp(p.xy + v, vec2(-u_space), vec2(u_space));
  o = vec4(np, p.zw);
}`
