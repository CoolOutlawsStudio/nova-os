/* Hand-written WebGL2 renderer: procedural terrain, instanced creatures/plants/particles, bloom post-processing. */
'use strict';
const GLR = (()=>{
let gl, canvas, ok=false;
let progTerrain, progCreature, progShadow, progPlant, progPart, progBright, progBlur, progComp;
let quadVBO, instVBO, vao, emptyVAO, wallTex, wallVer=-1;
let instData = new Float32Array(16*4096);
let fbScene, fbA, fbB, fbW=0, fbH=0;
const FLOATS = 16;

const VS_FULL = `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); gl_Position = vec4(p*2.0-1.0,0.0,1.0); }`;

const VS_INST = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 i0;
layout(location=2) in vec4 i1;
layout(location=3) in vec4 i2;
layout(location=4) in vec4 i3;
uniform vec2 u_cam; uniform float u_zoom; uniform vec2 u_view; uniform vec2 u_shadowOff;
out vec2 v_uv; out vec2 v_ext; out vec4 v_i1; out vec4 v_col; out vec4 v_p;
void main(){
  float c = cos(i1.x), s = sin(i1.x);
  vec2 l = a_corner * i0.zw;
  vec2 w = i0.xy + vec2(l.x*c - l.y*s, l.x*s + l.y*c) + u_shadowOff * i1.y;
  vec2 sc = (w - u_cam) * u_zoom / (u_view*0.5);
  gl_Position = vec4(sc.x, -sc.y, 0.0, 1.0);
  v_uv = a_corner; v_ext = i0.zw / max(i1.y, 1e-4); v_i1 = i1; v_col = i2; v_p = i3;
}`;

const NOISE = `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x), u.y); }
float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.03+vec2(1.7,9.2); a*=0.5; } return s; }
`;

const FS_TERRAIN = `#version 300 es
precision highp float;
uniform vec2 u_cam; uniform float u_zoom; uniform vec2 u_view; uniform vec2 u_res;
uniform float u_season, u_daylight, u_drought, u_frost, u_growth, u_time, u_wet;
uniform vec3 u_ambient; uniform vec2 u_lightDir;
uniform vec3 u_hot[6];
uniform vec4 u_scorch[4];
uniform sampler2D u_walls;
out vec4 o;
${NOISE}
vec3 palL(int i){ if(i==0) return vec3(0.20,0.43,0.17); if(i==1) return vec3(0.31,0.43,0.13); if(i==2) return vec3(0.47,0.31,0.11); return vec3(0.66,0.72,0.77); }
vec3 palD(int i){ if(i==0) return vec3(0.37,0.42,0.21); if(i==1) return vec3(0.50,0.50,0.27); if(i==2) return vec3(0.46,0.33,0.18); return vec3(0.78,0.81,0.85); }
void main(){
  vec2 frag = gl_FragCoord.xy / u_res * u_view; frag.y = u_view.y - frag.y;
  vec2 p = (frag - u_view*0.5)/u_zoom + u_cam;
  int s0 = int(floor(u_season)) % 4; int s1 = (s0+1)%4; float sf = smoothstep(0.55, 1.0, fract(u_season));
  vec3 lush = mix(palL(s0), palL(s1), sf), dry = mix(palD(s0), palD(s1), sf);
  float winter = (s0==3 ? 1.0-sf : 0.0) + (s1==3 ? sf : 0.0);
  float e = fbm(p*0.0022);
  float m = fbm(p*0.0031 + 17.3);
  float fert = 0.0;
  for (int i=0;i<6;i++){ vec2 d=p-u_hot[i].xy; fert += exp(-dot(d,d)/(u_hot[i].z*u_hot[i].z*0.9)); }
  float lushness = clamp(m*1.25 - 0.3 + fert*0.65*min(u_growth,1.6), 0.0, 1.0);
  vec3 g = mix(dry, lush, lushness);
  float gn = vnoise(p*0.09)*0.5 + vnoise(p*0.23)*0.3 + vnoise(p*0.61)*0.2;
  g *= 0.84 + gn*0.3;
  // grass blades shimmer in wind
  float blade = vnoise(vec2(p.x*0.5 + sin(p.y*0.05 + u_time*0.8)*2.0, p.y*0.12));
  g *= 0.95 + blade*0.1*(1.0-winter);
  // soil / dirt patches and darker moist lowlands
  float dirt = smoothstep(0.6, 0.74, vnoise(p*0.006+3.0)*0.6 + e*0.5);
  g = mix(g, vec3(0.30,0.23,0.15)*(0.85+gn*0.3), dirt*0.55*(1.0-lushness*0.5)*(1.0-winter*0.7));
  float low = smoothstep(0.42, 0.3, e);
  g = mix(g, g*vec3(0.75,0.85,0.95), low*0.5);
  // wet ground sheen during rain
  g *= 1.0 - u_wet*0.12; g += u_wet*0.04*vec3(0.5,0.6,0.8)*smoothstep(0.5,0.8,vnoise(p*0.02));
  // drought: parched + cracked earth
  if (u_drought > 0.001){
    g = mix(g, vec3(0.64,0.53,0.31)*(0.88+gn*0.25), u_drought*0.65);
    vec2 cp = p*0.045; float cr = abs(vnoise(cp)-vnoise(cp*1.9+4.0));
    g *= 1.0 - u_drought*0.45*smoothstep(0.05, 0.0, cr);
  }
  // frost / snow cover
  float snow = max(u_frost, winter*0.55);
  g = mix(g, vec3(0.86,0.91,0.98)*(0.93+gn*0.09), snow*smoothstep(0.25, 0.75, vnoise(p*0.012)*0.8 + snow*0.5));
  // meteor scorch marks
  for (int i=0;i<4;i++){ vec4 sc = u_scorch[i]; if (sc.z <= 0.0) continue; float d = length(p-sc.xy)/sc.z;
    float k = smoothstep(1.0, 0.2, d + (vnoise(p*0.04)-0.5)*0.35) * sc.w; g = mix(g, vec3(0.08,0.06,0.05), k*0.85);
    g += vec3(1.0,0.35,0.05)*smoothstep(0.35,0.0,d)*sc.w*sc.w*0.8; }
  // rock ridges (walls) with lighting + cast shadow
  vec2 inv = vec2(1.0/2000.0, 1.0/1300.0);
  vec2 wuv = p*inv;
  float w = texture(u_walls, wuv).r; w = clamp(w + (vnoise(p*0.07)-0.5)*0.3*smoothstep(0.05,0.4,w), 0.0, 1.0);
  float wsh = texture(u_walls, (p + u_lightDir*24.0)*inv).r;
  g *= 1.0 - 0.5*smoothstep(0.15, 0.6, wsh)*(1.0 - smoothstep(0.3,0.5,w))*(0.4+0.6*u_daylight);
  float edge = smoothstep(0.08, 0.3, w) * (1.0 - smoothstep(0.3,0.5,w));
  g *= 1.0 - edge*0.25;
  if (w > 0.3){
    float ex = texture(u_walls, (p+vec2(6.0,0.0))*inv).r - texture(u_walls, (p-vec2(6.0,0.0))*inv).r;
    float ey = texture(u_walls, (p+vec2(0.0,6.0))*inv).r - texture(u_walls, (p-vec2(0.0,6.0))*inv).r;
    vec3 n = normalize(vec3(-ex*2.5, -ey*2.5, 0.6 + (vnoise(p*0.15)-0.5)*0.4));
    float lit = clamp(dot(n, normalize(vec3(u_lightDir, 0.8))), 0.0, 1.0);
    vec3 rock = vec3(0.40,0.37,0.35) * (0.75 + vnoise(p*0.11)*0.35 + vnoise(p*0.5)*0.15);
    rock = mix(rock, vec3(0.9,0.93,0.97), clamp(snow*1.2 + winter*0.3, 0.0, 1.0)*smoothstep(0.5, 0.9, w));
    vec3 rc = rock * (0.45 + 0.85*lit);
    g = mix(g, rc, smoothstep(0.3, 0.5, w));
  }
  // outside world: dark misty void
  vec2 out2 = max(max(-p, p - vec2(2000.0,1300.0)), 0.0);
  float od = length(out2);
  vec3 col = g * u_ambient;
  if (od > 0.0){ col = mix(col*0.35, vec3(0.02,0.025,0.04), smoothstep(0.0, 60.0, od)); }
  // soft world edge
  float ed = min(min(p.x, 2000.0-p.x), min(p.y, 1300.0-p.y));
  col *= mix(0.55, 1.0, smoothstep(0.0, 40.0, ed));
  o = vec4(col, 1.0);
}`;

const FS_SHADOW = `#version 300 es
precision highp float;
in vec2 v_uv; in vec2 v_ext; in vec4 v_i1; in vec4 v_col; in vec4 v_p;
uniform float u_shadowA;
out vec4 o;
void main(){ vec2 q = v_uv*v_ext; float d = length(q/vec2(1.5,1.0)); float a = smoothstep(1.25, 0.2, d) * u_shadowA * v_col.a; o = vec4(0.0,0.0,0.0,a); }`;

const FS_CREATURE = `#version 300 es
precision highp float;
in vec2 v_uv; in vec2 v_ext; in vec4 v_i1; in vec4 v_col; in vec4 v_p;
uniform vec3 u_ambient; uniform vec2 u_lightDir; uniform float u_glow;
out vec4 o;
float sdEll(vec2 p, vec2 r){ float k0=length(p/r); float k1=length(p/(r*r)); return k0*(k0-1.0)/max(k1,1e-4); }
float smin(float a,float b,float k){ float h=clamp(0.5+0.5*(b-a)/k,0.0,1.0); return mix(b,a,h)-k*h*(1.0-h); }
float sdSeg(vec2 p, vec2 a, vec2 b, float r){ vec2 pa=p-a, ba=b-a; float h=clamp(dot(pa,ba)/dot(ba,ba),0.0,1.0); return length(pa-ba*h)-r; }
void main(){
  vec2 q = v_uv * v_ext;
  float ph = v_i1.z, look = v_i1.w, pred = v_p.x, en = v_p.y, att = v_p.z, hurt = v_p.w;
  float bend = sin(ph*0.9 - q.x*1.6) * 0.16 * clamp(0.6 - q.x, 0.0, 2.5);
  vec2 b = vec2(q.x, q.y - bend);
  float d, limbs = 1e5, eyeX, eyeY, eyeR;
  if (pred < 0.5){
    d = sdEll(b - vec2(0.0,0.0), vec2(1.1, 0.8));
    d = smin(d, sdEll(b - vec2(0.78,0.0), vec2(0.5,0.47)), 0.25);
    float tw = sin(ph*0.9 + 1.2)*0.35;
    vec2 t = b - vec2(-1.0, 0.0);
    d = smin(d, sdSeg(t, vec2(0.0), vec2(-0.7, tw), 0.12), 0.22);
    limbs = length(t - vec2(-0.78, tw*1.05)) - 0.27;
    for (int i=0;i<4;i++){
      float fi=float(i); float side = (i==0||i==2)?1.0:-1.0; float fx = (i<2)?0.42:-0.42;
      float sw = sin(ph*1.8 + fi*1.57) * 0.25;
      limbs = min(limbs, sdSeg(q, vec2(fx, side*0.5), vec2(fx+sw, side*1.0), 0.12));
    }
    eyeX = 0.92; eyeY = 0.27; eyeR = 0.17;
  } else {
    d = sdEll(b, vec2(1.3, 0.6));
    d = smin(d, sdEll(b - vec2(0.95,0.0), vec2(0.62,0.5)), 0.2);
    float open = att*0.45 + 0.04;
    vec2 m = b - vec2(1.62,0.0);
    float notch = max(-m.x - 0.6, abs(m.y) - (-m.x)*open);
    d = max(d, -notch);
    float tw = sin(ph*0.9+1.0)*0.42;
    vec2 t = b - vec2(-1.15,0.0);
    d = smin(d, sdSeg(t, vec2(0.0), vec2(-1.05, tw), 0.09), 0.2);
    limbs = sdSeg(t, vec2(-0.85, tw*0.8), vec2(-1.25, tw*1.3+0.3), 0.07);
    limbs = min(limbs, sdSeg(t, vec2(-0.85, tw*0.8), vec2(-1.25, tw*1.3-0.3), 0.07));
    for (int i=0;i<2;i++){
      float side = i==0?1.0:-1.0;
      float fl = sin(ph*1.6 + side)*0.2;
      limbs = min(limbs, sdSeg(b, vec2(0.25, side*0.4), vec2(-0.5, side*(1.08+fl)), 0.1));
    }
    eyeX = 1.08; eyeY = 0.25; eyeR = 0.14;
  }
  vec3 col = v_col.rgb;
  float lum = dot(col, vec3(0.3,0.59,0.11));
  col = mix(vec3(lum), col, 0.4 + 0.6*en);
  float ghost = 1.0 - v_col.a;
  col = mix(col, vec3(lum*0.8), ghost);
  float rr = v_i1.x; vec2 ld = vec2(cos(rr)*u_lightDir.x + sin(rr)*u_lightDir.y, -sin(rr)*u_lightDir.x + cos(rr)*u_lightDir.y);
  float aa = max(fwidth(d), 0.02);
  float aB = 1.0 - smoothstep(-aa, aa, d);
  float aL = 1.0 - smoothstep(-aa, aa, limbs);
  float dome = sqrt(clamp(-d*1.6, 0.0, 1.0));
  vec2 nrm = normalize(b + 1e-4);
  float shade = 0.72 + 0.42*dot(nrm, ld)*(1.0-dome) + 0.22*dome;
  float pat;
  if (pred < 0.5){ vec2 sp = b*vec2(2.3,2.6) + vec2(0.3, 0.15); pat = smoothstep(0.22, 0.14, length(fract(sp)-0.5)) * smoothstep(0.55, 0.2, b.x); }
  else { pat = smoothstep(0.2, 0.6, sin(b.x*8.5)) * smoothstep(0.08, 0.38, abs(b.y)) * smoothstep(0.9, 0.3, b.x); }
  vec3 bodyC = col * shade;
  bodyC = mix(bodyC, col*0.5, pat*0.5);
  bodyC = mix(bodyC, col*0.42, smoothstep(-0.16, -0.01, d));       // rim
  bodyC += vec3(1.0)*exp(-dot(b - ld*0.42, b - ld*0.42)*7.0)*0.28;   // specular
  vec3 limbC = col*0.55;
  // eyes, pupils look toward target
  vec2 lp = vec2(cos(look), sin(look))*0.075;
  float blink = step(0.985, fract(ph*0.031 + v_col.r*7.3));
  vec3 emis = vec3(0.0);
  float eyeA = 0.0; vec3 eyeC = vec3(0.0);
  for (int i=0;i<2;i++){
    float side = i==0?1.0:-1.0;
    vec2 e = b - vec2(eyeX, side*eyeY);
    e.y /= mix(1.0, 0.15, blink);
    float de = length(e) - eyeR;
    float a = 1.0 - smoothstep(-aa, aa, de);
    vec3 white = pred<0.5 ? vec3(0.97) : vec3(1.0,0.86,0.45);
    float dp = length(e - lp) - eyeR*0.55;
    vec3 c = mix(white, vec3(0.03), 1.0 - smoothstep(-aa,aa,dp));
    c += vec3(1.0)*smoothstep(eyeR*0.25, 0.0, length(e - lp - vec2(0.03,-0.03)));
    eyeC = mix(eyeC, c, a); eyeA = max(eyeA, a);
    if (pred > 0.5) emis += vec3(1.0,0.55,0.1)*a*0.7;
  }
  vec3 amb = max(u_ambient, vec3(0.42,0.45,0.55));
  vec3 lit = mix(limbC*amb, bodyC*amb, aB);
  float alpha = max(aB, aL);
  lit = mix(lit, eyeC*max(u_ambient, vec3(0.55)) + emis, eyeA*aB);
  lit = mix(lit, vec3(1.0,0.35,0.3), hurt*0.6*alpha);
  // halo glow (bioluminescent, stronger at night)
  float halo = exp(-max(min(d, limbs), 0.0)*2.4) * (1.0 - alpha) * u_glow * (0.6 + 0.4*en) * (0.9 + pred*0.4);
  vec3 glowC = mix(col, vec3(1.0), 0.15) * halo;
  float fa = v_col.a;
  o = vec4((lit*alpha + glowC)*fa, alpha*fa);
}`;

const FS_PLANT = `#version 300 es
precision highp float;
in vec2 v_uv; in vec2 v_ext; in vec4 v_i1; in vec4 v_col; in vec4 v_p;
uniform vec3 u_ambient; uniform float u_glow;
out vec4 o;
void main(){
  vec2 q = v_uv * v_ext;
  float ang = atan(q.y, q.x);
  float lobes = 5.0 + floor(v_p.w*3.0);
  float rr = 0.58 + 0.34*abs(cos(lobes*0.5*ang));
  float r = length(q);
  float d = r - rr;
  float aa = max(fwidth(d), 0.03);
  float a = 1.0 - smoothstep(-aa, aa, d);
  vec3 c = v_col.rgb * (0.65 + 0.55*(1.0 - r/rr));
  float vein = smoothstep(0.08, 0.0, abs(sin(lobes*0.5*ang))*r);
  c = mix(c, c*0.6, vein*0.6);
  float fl = v_i1.w;
  float dc = length(q) - 0.28;
  float fa = (1.0 - smoothstep(-aa, aa, dc)) * fl;
  vec3 lit = c*u_ambient;
  lit = mix(lit, v_p.rgb*max(u_ambient, vec3(0.6)) + v_p.rgb*0.25, fa);
  float shadow = smoothstep(1.25, 0.8, length(q - vec2(0.18,0.22))) * (1.0 - a) * 0.35;
  float halo = exp(-max(d,0.0)*3.0)*(1.0-a)*u_glow*0.25*v_i1.z;
  o = vec4(lit*a + v_col.rgb*halo, max(a, shadow)) * v_col.a;
  o.rgb *= 1.0; 
}`;

const FS_PART = `#version 300 es
precision highp float;
in vec2 v_uv; in vec2 v_ext; in vec4 v_i1; in vec4 v_col; in vec4 v_p;
out vec4 o;
void main(){
  float t = v_p.x; vec2 u = v_uv; float r = length(u); float a;
  if (t < 0.5) a = exp(-r*r*4.0);
  else if (t < 1.5) a = smoothstep(0.08, 0.0, abs(r - 0.85)) ;
  else if (t < 2.5) { a = 1.0 - smoothstep(0.85, 1.0, length(u/vec2(1.0,0.5))); a *= 0.75 + 0.25*step(0.06, abs(u.y)); }
  else if (t < 3.5) a = exp(-u.x*u.x*6.0) * smoothstep(1.0, 0.2, abs(u.y));
  else if (t < 4.5) a = exp(-r*r*5.0) + 0.5*exp(-abs(u.x*u.y)*60.0)*smoothstep(1.0,0.3,r);
  else if (t < 5.5) a = smoothstep(1.0, 0.0, r)*smoothstep(1.0,0.0,r);
  else if (t < 6.5) a = exp(-u.y*u.y*7.0) * smoothstep(1.0, 0.0, abs(u.x));
  else a = exp(-r*r*6.0) * (0.75 + 0.25*sin(v_p.y*0.3));
  a = clamp(a, 0.0, 1.0) * v_col.a;
  if (v_p.z > 0.5) o = vec4(v_col.rgb*a, 0.0);     // additive
  else o = vec4(v_col.rgb*a, a);                    // premultiplied alpha
}`;

const FS_BRIGHT = `#version 300 es
precision highp float;
uniform sampler2D u_tex; uniform vec2 u_texel; out vec4 o;
void main(){ vec2 uv = gl_FragCoord.xy * u_texel;
  vec3 c = vec3(0.0);
  c += texture(u_tex, uv + u_texel*vec2(-0.5,-0.5)).rgb; c += texture(u_tex, uv + u_texel*vec2(0.5,-0.5)).rgb;
  c += texture(u_tex, uv + u_texel*vec2(-0.5,0.5)).rgb;  c += texture(u_tex, uv + u_texel*vec2(0.5,0.5)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  o = vec4(c * smoothstep(0.55, 0.95, l), 1.0); }`;

const FS_BLUR = `#version 300 es
precision highp float;
uniform sampler2D u_tex; uniform vec2 u_dir; uniform vec2 u_texel; out vec4 o;
void main(){ vec2 uv = gl_FragCoord.xy * u_texel;
  vec3 c = texture(u_tex, uv).rgb * 0.227;
  c += texture(u_tex, uv + u_dir*1.385).rgb * 0.316; c += texture(u_tex, uv - u_dir*1.385).rgb * 0.316;
  c += texture(u_tex, uv + u_dir*3.231).rgb * 0.070; c += texture(u_tex, uv - u_dir*3.231).rgb * 0.070;
  o = vec4(c, 1.0); }`;

const FS_COMP = `#version 300 es
precision highp float;
uniform sampler2D u_scene, u_bloom; uniform vec2 u_res; uniform float u_bloomStr, u_heat, u_time, u_flash; uniform vec3 u_flashCol, u_grade;
out vec4 o;
void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  if (u_heat > 0.0){ uv += vec2(sin(uv.y*70.0 + u_time*3.1), cos(uv.x*55.0 + u_time*2.3)) * 0.0014 * u_heat; }
  vec3 c = texture(u_scene, uv).rgb;
  vec3 bl = texture(u_bloom, uv).rgb;
  c += bl * u_bloomStr;
  c *= u_grade;
  c += u_flashCol * u_flash;
  float l = dot(c, vec3(0.299,0.587,0.114));
  c = mix(vec3(l), c, 1.08);
  c = c / (1.0 + max(c - 0.85, 0.0)*0.9);   // soft shoulder
  vec2 v = uv - 0.5; c *= 1.0 - 0.42*dot(v,v)*1.6;
  o = vec4(c, 1.0);
}`;

function compile(type, src){
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader compile error: '+gl.getShaderInfoLog(s)+'\n'+src.split('\n').slice(0,3).join(' '));
  return s;
}
function program(vs, fs){
  const p = gl.createProgram(); gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link error: '+gl.getProgramInfoLog(p));
  const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i=0;i<n;i++){ const info = gl.getActiveUniform(p,i); const name = info.name.replace(/\[0\]$/,''); u[name] = gl.getUniformLocation(p, info.name); }
  return {p, u};
}
function makeFB(w,h){
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return {fb, tex, w, h};
}
function freeFB(f){ if (!f) return; gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }

function init(cv){
  canvas = cv;
  try {
    gl = cv.getContext('webgl2', {antialias:false, alpha:false, premultipliedAlpha:false, preserveDrawingBuffer:true, powerPreference:'high-performance'});
    if (!gl) return false;
    progTerrain = program(VS_FULL, FS_TERRAIN);
    progShadow = program(VS_INST, FS_SHADOW);
    progCreature = program(VS_INST, FS_CREATURE);
    progPlant = program(VS_INST, FS_PLANT);
    progPart = program(VS_INST, FS_PART);
    progBright = program(VS_FULL, FS_BRIGHT);
    progBlur = program(VS_FULL, FS_BLUR);
    progComp = program(VS_FULL, FS_COMP);
    vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    quadVBO = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    instVBO = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, instVBO);
    gl.bufferData(gl.ARRAY_BUFFER, instData.byteLength, gl.DYNAMIC_DRAW);
    for (let i=0;i<4;i++){ gl.enableVertexAttribArray(1+i); gl.vertexAttribPointer(1+i, 4, gl.FLOAT, false, FLOATS*4, i*16); gl.vertexAttribDivisor(1+i, 1); }
    gl.bindVertexArray(null);
    emptyVAO = gl.createVertexArray();
    wallTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, wallTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    cv.addEventListener('webglcontextlost', e=>{ e.preventDefault(); ok=false; }, false);
    ok = true;
  } catch(err){ console.warn('WebGL2 renderer unavailable, falling back to 2D:', err.message); ok=false; }
  return ok;
}

function ensureFB(w,h){
  if (w===fbW && h===fbH) return;
  freeFB(fbScene); freeFB(fbA); freeFB(fbB);
  fbScene = makeFB(w,h);
  const bw = Math.max(1, w>>2), bh = Math.max(1, h>>2);
  fbA = makeFB(bw,bh); fbB = makeFB(bw,bh);
  fbW=w; fbH=h;
}
function uploadWalls(){
  // upsample the 20px wall grid 4x and blur it so ridges read as smooth natural rock
  const SC = 4, w = GW*SC, h = GH*SC;
  let a = new Float32Array(w*h), b = new Float32Array(w*h);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) a[y*w+x] = walls[((y/SC)|0)*GW + ((x/SC)|0)];
  const K = [0.05,0.09,0.12,0.15,0.18,0.15,0.12,0.09,0.05], R = 4;
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){ let s=0; for (let k=-R;k<=R;k++){ const xx = x+k<0?0:x+k>=w?w-1:x+k; s += a[y*w+xx]*K[k+R]; } b[y*w+x]=s; }
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){ let s=0; for (let k=-R;k<=R;k++){ const yy = y+k<0?0:y+k>=h?h-1:y+k; s += b[yy*w+x]*K[k+R]; } a[y*w+x]=s; }
  const d = new Uint8Array(w*h); for (let i=0;i<d.length;i++) d[i] = Math.min(255, a[i]*255*1.15);
  gl.bindTexture(gl.TEXTURE_2D, wallTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, d);
  wallVer = wallsVersion;
}
let instN = 0;
function beginInst(){ instN = 0; }
function pushInst(x,y,sx,sy, rot,r,p,q, cr,cg,cb,ca, a,b,c,d){
  if ((instN+1)*FLOATS > instData.length){ const nd = new Float32Array(instData.length*2); nd.set(instData); instData = nd; }
  const o = instN*FLOATS; const D = instData;
  D[o]=x; D[o+1]=y; D[o+2]=sx; D[o+3]=sy; D[o+4]=rot; D[o+5]=r; D[o+6]=p; D[o+7]=q;
  D[o+8]=cr; D[o+9]=cg; D[o+10]=cb; D[o+11]=ca; D[o+12]=a; D[o+13]=b; D[o+14]=c; D[o+15]=d;
  instN++;
}
let bufCap = 0;
function flushInst(prog){
  if (!instN) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, instVBO);
  const bytes = instN*FLOATS*4;
  if (bytes > bufCap){ bufCap = instData.byteLength; gl.bufferData(gl.ARRAY_BUFFER, bufCap, gl.DYNAMIC_DRAW); }
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, instData, 0, instN*FLOATS);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instN);
}
function setCam(pr, V){ gl.uniform2f(pr.u.u_cam, V.cam.x, V.cam.y); gl.uniform1f(pr.u.u_zoom, V.cam.z); gl.uniform2f(pr.u.u_view, V.vw, V.vh); }
function fullscreen(){ gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3); }

function lookAngle(c){
  const t = (c.target && !c.target.dead) ? c.target : (c.food && c.food.e>0.5 ? c.food : null);
  if (!t) return Math.sin(c.phase*0.05)*0.6;
  let a = Math.atan2(t.y-c.y, t.x-c.x) - c.a; a = Math.atan2(Math.sin(a), Math.cos(a));
  return clamp(a, -1.3, 1.3);
}

function render(V){
  if (!ok) return false;
  const w = canvas.width, h = canvas.height;
  ensureFB(w,h);
  if (wallVer !== wallsVersion) uploadWalls();
  const E = S.env, L = V.light;
  // ---------- scene pass
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbScene.fb); gl.viewport(0,0,w,h);
  gl.disable(gl.BLEND);
  let pr = progTerrain; gl.useProgram(pr.p); setCam(pr, V);
  gl.uniform2f(pr.u.u_res, w, h);
  gl.uniform1f(pr.u.u_season, V.seasonF); gl.uniform1f(pr.u.u_daylight, E.daylight);
  gl.uniform1f(pr.u.u_drought, V.drought); gl.uniform1f(pr.u.u_frost, V.frost); gl.uniform1f(pr.u.u_wet, V.wet);
  gl.uniform1f(pr.u.u_growth, E.growth*CFG.food); gl.uniform1f(pr.u.u_time, V.time);
  gl.uniform3fv(pr.u.u_ambient, L.ambient); gl.uniform2f(pr.u.u_lightDir, L.dir[0], L.dir[1]);
  const hot = new Float32Array(18); S.hotspots.forEach((h,i)=>{ hot[i*3]=h.x; hot[i*3+1]=h.y; hot[i*3+2]=h.r; });
  gl.uniform3fv(pr.u.u_hot, hot);
  const sc = new Float32Array(16); VFX.scorch.slice(-4).forEach((s,i)=>{ sc[i*4]=s.x; sc[i*4+1]=s.y; sc[i*4+2]=s.r; sc[i*4+3]=1-s.t/2400; });
  gl.uniform4fv(pr.u.u_scorch, sc);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, wallTex); gl.uniform1i(pr.u.u_walls, 0);
  fullscreen();

  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindVertexArray(vao);
  const vx0 = V.view.x0-20, vx1 = V.view.x1+20, vy0 = V.view.y0-20, vy1 = V.view.y1+20;
  const inView = (x,y)=> x>vx0 && x<vx1 && y>vy0 && y<vy1;
  // ---------- plants
  pr = progPlant; gl.useProgram(pr.p); setCam(pr, V); gl.uniform2f(pr.u.u_shadowOff,0,0);
  gl.uniform3fv(pr.u.u_ambient, L.ambient); gl.uniform1f(pr.u.u_glow, V.glow);
  beginInst();
  const pc = V.plantCol, fc = V.flowerCol, flowering = V.flowering;
  for (const p of S.plants){
    if (p.e < 0.5 || !inView(p.x,p.y)) continue;
    const ef = p.e/PLANT_MAX_E, r = 2.2 + ef*3.2;
    const grow = Math.min(1, (S.t - p.born)/30 + 0.2);
    const sway = Math.sin(V.time*1.6 + p.s*3 + p.x*0.01)*0.12;
    const tint = 0.75 + 0.35*ef;
    const fl = flowering && ef>0.6 && (p.s*7)%1 < 0.45 ? 1 : 0;
    pushInst(p.x, p.y, r*1.35*grow, r*1.35*grow, p.s+sway, r*grow, ef, fl, pc[0]*tint, pc[1]*tint, pc[2]*tint, 1, fc[0], fc[1], fc[2], (p.s*13)%1);
  }
  flushInst(pr);
  // ---------- creature shadows
  const ghosts = VFX.ghosts;
  pr = progShadow; gl.useProgram(pr.p); setCam(pr, V);
  gl.uniform2f(pr.u.u_shadowOff, -L.dir[0]*0.5*L.shadowLen, -L.dir[1]*0.5*L.shadowLen); gl.uniform1f(pr.u.u_shadowA, 0.18 + 0.25*E.daylight);
  beginInst();
  for (const c of S.creatures){ if (!inView(c.x,c.y)) continue; const r=c.r*birthScale(c); pushInst(c.x,c.y,r*1.9,r*1.4,c.a,r,0,0, 0,0,0,1, 0,0,0,0); }
  flushInst(pr);
  // ---------- creatures (+ fading ghosts)
  pr = progCreature; gl.useProgram(pr.p); setCam(pr, V); gl.uniform2f(pr.u.u_shadowOff,0,0);
  gl.uniform3fv(pr.u.u_ambient, L.ambient); gl.uniform2f(pr.u.u_lightDir, L.dir[0], L.dir[1]); gl.uniform1f(pr.u.u_glow, V.glow);
  beginInst();
  for (const g of ghosts){ const c=g.c; if (!inView(c.x,c.y)) continue; const k = 1 - g.t/g.max; const r = c.r*(0.6+0.4*k);
    pushInst(c.x,c.y,r*3.2,r*2.4,c.a,r,c.phase,0, c.rgb[0],c.rgb[1],c.rgb[2],k*0.85, c.pred?1:0,0,0,0); }
  for (const c of S.creatures){
    if (!inView(c.x,c.y)) continue;
    const r = c.r*birthScale(c);
    pushInst(c.x,c.y,r*3.2,r*2.4,c.a,r,c.phase,lookAngle(c), c.rgb[0],c.rgb[1],c.rgb[2],1, c.pred?1:0, clamp(c.energy/c.maxE,0,1), clamp(c.attacking,0,1), c.hurt/6);
  }
  flushInst(pr);
  // ---------- particles (alpha then additive)
  pr = progPart; gl.useProgram(pr.p); setCam(pr, V); gl.uniform2f(pr.u.u_shadowOff,0,0);
  for (let pass=0; pass<2; pass++){
    beginInst();
    for (let i=0;i<P.n;i++){
      if (P.add[i] !== pass) continue;
      const x=P.x[i], y=P.y[i]; if (!inView(x,y)) continue;
      const k = P.life[i]/P.max[i]; const t = P.type[i];
      let fade = t===1 ? (1-k) : t===7 ? Math.sin(k*Math.PI) : t===4 ? Math.min(1,(1-k)*4)*Math.min(1,k*8) : (1-k)*(1-k*0.3);
      let sx = P.size[i], sy = P.size[i], rot = P.rot[i];
      if (t===3){ sx = 1.2; sy = 10; }
      if (t===6){ const sp = Math.hypot(P.vx[i],P.vy[i]); sx = P.size[i]*(1+sp*1.4); sy = P.size[i]*0.55; rot = Math.atan2(P.vy[i],P.vx[i]); }
      if (t===2){ sy = P.size[i]; sx = P.size[i]*1.6; }
      const amb = (t===5 || t===2) ? L.ambient : null;
      const cr = amb ? P.r[i]*amb[0] : P.r[i], cg = amb ? P.g[i]*amb[1] : P.g[i], cb = amb ? P.b[i]*amb[2] : P.b[i];
      pushInst(x,y,sx,sy,rot,1,0,0, cr,cg,cb,P.a[i]*fade, t, P.life[i], pass, 0);
    }
    if (pass===1) gl.blendFunc(gl.ONE, gl.ONE); else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    flushInst(pr);
  }
  gl.disable(gl.BLEND);
  gl.bindVertexArray(null);
  // ---------- bloom
  if (V.bloom){
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbA.fb); gl.viewport(0,0,fbA.w,fbA.h);
    pr = progBright; gl.useProgram(pr.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fbScene.tex);
    gl.uniform1i(pr.u.u_tex, 0); gl.uniform2f(pr.u.u_texel, 1/fbA.w, 1/fbA.h); fullscreen();
    pr = progBlur; gl.useProgram(pr.p); gl.uniform1i(pr.u.u_tex, 0); gl.uniform2f(pr.u.u_texel, 1/fbA.w, 1/fbA.h);
    for (let it=0; it<2; it++){
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbB.fb); gl.bindTexture(gl.TEXTURE_2D, fbA.tex); gl.uniform2f(pr.u.u_dir, (1+it)/fbA.w, 0); fullscreen();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbA.fb); gl.bindTexture(gl.TEXTURE_2D, fbB.tex); gl.uniform2f(pr.u.u_dir, 0, (1+it)/fbA.h); fullscreen();
    }
  }
  // ---------- composite
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0,0,w,h);
  pr = progComp; gl.useProgram(pr.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fbScene.tex); gl.uniform1i(pr.u.u_scene, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, fbA.tex); gl.uniform1i(pr.u.u_bloom, 1);
  gl.uniform2f(pr.u.u_res, w, h); gl.uniform1f(pr.u.u_bloomStr, V.bloom ? 1.15 : 0.0);
  gl.uniform1f(pr.u.u_heat, V.heat); gl.uniform1f(pr.u.u_time, V.time); gl.uniform1f(pr.u.u_flash, VFX.flash);
  gl.uniform3fv(pr.u.u_flashCol, VFX.flashCol); gl.uniform3fv(pr.u.u_grade, V.grade);
  fullscreen();
  gl.activeTexture(gl.TEXTURE0);
  return true;
}
function birthScale(c){ const a = S.t - c.born; return a >= 25 ? 1 : 0.35 + 0.65*(a/25); }
return { init, render, get ok(){ return ok; }, lookAngle, birthScale };
})();
