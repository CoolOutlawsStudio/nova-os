/* Living World Simulator — simulation core (no rendering). */
'use strict';
/* ===================== RNG ===================== */
let rngState = 1;
function hashStr(s){ let h = 1779033703 ^ s.length; for (let i=0;i<s.length;i++){ h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = h<<13 | h>>>19; } h = Math.imul(h ^ h>>>16, 2246822507); h = Math.imul(h ^ h>>>13, 3266489909); return (h ^ h>>>16)>>>0; }
function rand(){ let t = rngState = (rngState + 0x6D2B79F5)|0; t = Math.imul(t ^ t>>>15, t|1); t ^= t + Math.imul(t ^ t>>>7, t|61); return ((t ^ t>>>14)>>>0)/4294967296; }
let spareN = null;
function randn(){ if (spareN !== null){ const v=spareN; spareN=null; return v; } let u=0,v=0; while(u===0) u=rand(); v=rand(); const m=Math.sqrt(-2*Math.log(u)); spareN = m*Math.sin(2*Math.PI*v); return m*Math.cos(2*Math.PI*v); }
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const lerp=(a,b,t)=>a+(b-a)*t;

/* ===================== WORLD CONSTANTS ===================== */
const W = 2000, H = 1300;
const CS = 60, HGW = Math.ceil(W/CS), HGH = Math.ceil(H/CS);
const WCELL = 20, GW = W/WCELL, GH = H/WCELL;
const YEAR = 3600, DAY = 720, SEASONS = ['Spring','Summer','Autumn','Winter'], SEASON_ICON=['🌱','☀️','🍂','❄️'];
const MAX_PLANTS = 1700, PLANT_MAX_E = 30;
const CFG = { food:1, mut:1, maxPop:550, sexual:true, respawn:true, dayNight:true };

/* ===================== GENOME ===================== */
const GDEF = {
  speed:[0.6,3.2], size:[3,13], vision:[30,220], metab:[0.6,1.5], diet:[0,1],
  repro:[0.45,0.95], coat:[0,1], lifespan:[0.6,1.4], hueA:[0,1]
};
const GKEYS = Object.keys(GDEF);
const GLABEL = {speed:'Speed',size:'Size',vision:'Vision',metab:'Metabolism',diet:'Diet (carn.)',repro:'Repro thr.',coat:'Fur/coat',lifespan:'Lifespan',hueA:'Lineage hue'};
function gnorm(g,k){ const r=GDEF[k]; return (g[k]-r[0])/(r[1]-r[0]); }

/* ===================== BRAIN ===================== */
const NI = 12, NH = 10, NO = 3;
const NW = NI*NH + NH + NH*NO + NO;
const IN_LABELS = ['food sin','food cos','food near','crt sin','crt cos','crt near','rel size','threat','energy','temp','wall','osc'];
const OUT_LABELS = ['turn','throttle','attack'];
const iW1=(i,h)=>h*NI+i, iB1=h=>NI*NH+h, iW2=(h,o)=>NI*NH+NH+o*NH+h, iB2=o=>NI*NH+NH+NH*NO+o;
function forward(w, inp, hid, out){
  let k=0;
  for (let h=0;h<NH;h++){ let s=0; for(let i=0;i<NI;i++) s+=w[k++]*inp[i]; hid[h]=s; }
  for (let h=0;h<NH;h++){ hid[h]=Math.tanh(hid[h]+w[k++]); }
  for (let o=0;o<NO;o++){ let s=0; for(let h=0;h<NH;h++) s+=w[k++]*hid[h]; out[o]=s; }
  for (let o=0;o<NO;o++){ out[o]=Math.tanh(out[o]+w[k++]); }
}
function priorBrain(diet){
  const w = new Float32Array(NW);
  for (let k=0;k<NW;k++) w[k]=randn()*0.3;
  const pred = diet>0.5;
  if (!pred){ w[iW1(0,0)]+=2.6; } else { w[iW1(3,0)]+=2.6; }
  w[iW2(0,0)] += 2.0;
  w[iB1(1)] += 1.2; w[iW2(1,1)] += 1.6;
  w[iW1(8,1)] -= 0.4;
  if (pred){ w[iW1(5,2)]+=3; w[iW1(6,2)]-=2.2; w[iB1(2)]-=0.8; w[iW2(2,2)]+=2.6; w[iW1(5,1)]+=1.0; }
  else { w[iB2(2)] -= 1.8; w[iW1(7,3)] -= 3.0; w[iW2(3,0)] += 2.2; w[iW1(5,1)] += 0.6; }
  w[iW1(10,4)] += 3.0; w[iW2(4,0)] += 1.6; w[iW2(4,1)] -= 0.8;
  return w;
}

/* ===================== NAMES ===================== */
const SYL = ['ka','lo','mi','ra','zu','te','no','vi','sa','qu','el','ox','ar','fi','du','ny','po','ge','ba','ish','or','um','ze','ty'];
function nameOf(id){ let h = hashStr('n'+id), s=''; const n = 2 + (h%2); for (let i=0;i<n;i++){ s += SYL[h % SYL.length]; h = Math.floor(h / SYL.length) + 7919*i; } return s[0].toUpperCase()+s.slice(1); }

function hsl2rgb(h,s,l){ h/=360; const a=s*Math.min(l,1-l); const f=n=>{ const k=(n+h*12)%12; return l - a*Math.max(-1, Math.min(k-3, 9-k, 1)); }; return [f(0),f(8),f(4)]; }

/* ===================== STATE ===================== */
let S;
let nextId = 1;
const cGrid = Array.from({length:HGW*HGH},()=>[]);
const pGrid = Array.from({length:HGW*HGH},()=>[]);
let walls = new Uint8Array(GW*GH);
let wallsVersion = 1;

function randomGenes(diet){
  const g = {};
  for (const k of GKEYS){ const r=GDEF[k]; g[k]=lerp(r[0],r[1],rand()); }
  const pred = diet>0.5;
  g.diet = clamp(diet + randn()*0.04, 0, 1);
  g.size = pred ? 8 + rand()*2.5 : 5 + rand()*2.5;
  g.speed = pred ? 1.9 + rand()*0.5 : 1.4 + rand()*0.6;
  g.vision = pred ? 120 + rand()*40 : 80 + rand()*50;
  g.repro = 0.62 + rand()*0.15;
  g.coat = 0.35 + rand()*0.3;
  g.metab = 0.9 + rand()*0.2;
  g.lifespan = 0.9 + rand()*0.2;
  return g;
}
function mutateGenes(g, rate){
  const n = Object.assign({}, g);
  for (const k of GKEYS){
    if (k==='hueA') continue;
    const r = GDEF[k];
    if (rand() < 0.3*rate) n[k] = clamp(n[k] + randn()*0.05*(r[1]-r[0]), r[0], r[1]);
  }
  n.hueA = ((n.hueA + randn()*0.025*rate) % 1 + 1) % 1;
  return n;
}
function mutateBrain(w, rate){
  const n = new Float32Array(w);
  if (rate<=0) return n;
  const p = 0.06*rate;
  for (let k=0;k<NW;k++) if (rand()<p) n[k] = clamp(n[k] + randn()*0.35, -5, 5);
  return n;
}
function crossover(g1,w1,g2,w2){
  const g = {};
  for (const k of GKEYS) g[k] = rand()<0.5 ? g1[k] : g2[k];
  let d = g2.hueA - g1.hueA; if (d>0.5) d-=1; if (d<-0.5) d+=1;
  g.hueA = ((g1.hueA + d*rand()) % 1 + 1) % 1;
  const w = new Float32Array(NW);
  const pick = []; for (let h=0;h<NH;h++) pick.push(rand()<0.5);
  for (let h=0;h<NH;h++){
    const src = pick[h]?w1:w2;
    for (let i=0;i<NI;i++) w[iW1(i,h)] = src[iW1(i,h)];
    w[iB1(h)] = src[iB1(h)];
    for (let o=0;o<NO;o++) w[iW2(h,o)] = src[iW2(h,o)];
  }
  for (let o=0;o<NO;o++) w[iB2(o)] = rand()<0.5 ? w1[iB2(o)] : w2[iB2(o)];
  return {g,w};
}
function genomeDist(a,b){
  let s=0; for (const k of GKEYS){ if (k==='hueA') continue; const d=gnorm(a,k)-gnorm(b,k); s+=d*d; }
  let dh = Math.abs(a.hueA-b.hueA); if (dh>0.5) dh=1-dh; s += (dh*2)*(dh*2);
  return Math.sqrt(s);
}

class Creature {
  constructor(g, w, x, y, gen, lineage){
    this.id = nextId++;
    this.name = nameOf(this.id);
    this.g = g; this.w = w;
    this.x = x; this.y = y; this.a = rand()*Math.PI*2; this.v = 0;
    this.gen = gen; this.lineage = lineage || this.id; this.lineageName = lineage ? nameOf(lineage) : this.name;
    this.age = 0; this.children = 0; this.kills = 0; this.cool = 0; this.born = S ? S.t : 0;
    this.inp = new Float32Array(NI); this.hid = new Float32Array(NH); this.out = new Float32Array(NO);
    this.dead = false; this.cause = '';
    this.r = g.size;
    this.maxE = 40 + 3*g.size*g.size;
    this.maxHp = g.size*6; this.hp = this.maxHp;
    this.maxAge = 3200 * g.lifespan * (0.6 + g.size/20);
    this.maturity = 380 / g.metab;
    this.maxSpeed = g.speed * (0.65 + 0.35*g.metab);
    this.plantEff = clamp(1 - g.diet*1.35, 0, 1);
    this.meatEff = clamp((g.diet-0.3)/0.6, 0, 1);
    this.pred = g.diet > 0.5;
    this.energy = this.maxE*0.5;
    const hue = 140*(1-g.diet) + (g.hueA-0.5)*100;
    const sat = 45 + (g.speed-0.6)/2.6*45;
    const lit = 62 - (g.size-3)/10*16;
    this.hue = (hue+360)%360;
    this.col = `hsl(${this.hue.toFixed(0)},${sat.toFixed(0)}%,${lit.toFixed(0)}%)`;
    this.colDark = `hsl(${this.hue.toFixed(0)},${sat.toFixed(0)}%,${(lit-28).toFixed(0)}%)`;
    this.rgb = hsl2rgb(this.hue, sat/100, lit/100);
    this.target = null; this.food = null; this.ate = 0; this.attacking = 0;
    this.phase = rand()*10; this.hurt = 0;
  }
}

function isWall(x,y){
  if (x<0||y<0||x>=W||y>=H) return true;
  return walls[((y/WCELL)|0)*GW + ((x/WCELL)|0)] === 1;
}
function defaultWalls(){
  walls.fill(0);
  for (let gy=0; gy<GH; gy++){ if (gy<GH*0.38 || gy>GH*0.62) walls[gy*GW + Math.floor(GW*0.36)] = 1; }
  for (let gx=Math.floor(GW*0.56); gx<GW; gx++){ if (gx<GW*0.72 || gx>GW*0.86) walls[Math.floor(GH*0.5)*GW + gx] = 1; }
  // thicken ridges a bit so they read as rock formations
  const cp = walls.slice();
  for (let gy=1; gy<GH-1; gy++) for (let gx=1; gx<GW-1; gx++){ const i=gy*GW+gx; if (!cp[i] && (cp[i-1]||cp[i+1]||cp[i-GW]||cp[i+GW]) && hashStr('w'+i)%3===0) walls[i]=1; }
  wallsVersion++;
}

function freeSpot(){
  for (let i=0;i<50;i++){ const x=20+rand()*(W-40), y=20+rand()*(H-40); if (!isWall(x,y)) return [x,y]; }
  return [W/2,H/2];
}
function fx(type, x, y, a, b){ if (S.fx.length < 3000 || type==='meteor') S.fx.push({type, x, y, a, b}); }
function spawnCreature(diet, x, y){
  if (x===undefined){ [x,y] = freeSpot(); }
  const g = randomGenes(diet);
  const c = new Creature(g, priorBrain(g.diet), x, y, 1, 0);
  c.energy = c.maxE*0.7;
  S.creatures.push(c); S.births++;
  fx('birth', x, y, c);
  return c;
}
function addPlant(x,y,e){
  if (S.plants.length >= MAX_PLANTS) return false;
  if (isWall(x,y)) return false;
  S.plants.push({x,y,e:e===undefined?6:e, s:rand()*6.283, born:S.t});
  return true;
}

function reset(seed){
  rngState = hashStr(String(seed)); spareN = null;
  nextId = 1;
  S = {
    seed:String(seed), t:0, creatures:[], plants:[], births:0, deaths:0, maxGen:1,
    hist:[], histEvery:15, plantAcc:0, fx:[], newborn:[],
    env:{temp:0, growth:1, season:0, year:1, event:null, eventLeft:0, daylight:1, phase:0},
    hotspots:[], log:[], species:0,
    bestEver:{name:'-', children:0, id:0}, oldestEver:{name:'-', age:0, id:0},
    extinctions:0, deathsBy:{starved:0, old:0, eaten:0, smitten:0, disaster:0}
  };
  for (let i=0;i<6;i++) S.hotspots.push({x:rand()*W, y:rand()*H, vx:randn()*0.08, vy:randn()*0.08, r:110+rand()*130});
  defaultWalls();
  for (let i=0;i<800;i++){ const [x,y]=plantSpot(); addPlant(x,y,5+rand()*25); }
  for (let i=0;i<130;i++) spawnCreature(0.08 + rand()*0.1);
  for (let i=0;i<14;i++) spawnCreature(0.85 + rand()*0.1);
  S.births = 0; S.fx.length = 0;
  logEvent('World created with seed "'+seed+'"');
  if (typeof onWorldReset === 'function') onWorldReset();
}

function plantSpot(){
  if (rand()<0.72 && S.hotspots.length){
    const h = S.hotspots[(rand()*S.hotspots.length)|0];
    return [clamp(h.x + randn()*h.r*0.6, 2, W-2), clamp(h.y + randn()*h.r*0.6, 2, H-2)];
  }
  return [rand()*W, rand()*H];
}

/* ===================== EVENTS ===================== */
const EVENTS = {
  drought: {name:'Drought', icon:'☀️', dur:900, growth:0.18, temp:0.3, col:'#d9a441'},
  bloom:   {name:'Bloom', icon:'🌸', dur:400, growth:2.4, temp:0.05, col:'#f0abfc', start(){ for(let i=0;i<380;i++){ const [x,y]=plantSpot(); addPlant(x,y,10+rand()*20);} }},
  coldsnap:{name:'Cold Snap', icon:'❄️', dur:650, growth:0.45, temp:-0.95, col:'#93c5fd'},
  heatwave:{name:'Heatwave', icon:'🔥', dur:600, growth:0.7, temp:0.85, col:'#fb923c'},
  meteor:  {name:'Meteor Strike', icon:'☄️', dur:150, growth:0.9, temp:0.1, col:'#fca5a5', start(){
    const [x,y] = freeSpot(); const R = 170;
    let k=0; for (const c of S.creatures){ if(!c.dead && (c.x-x)**2+(c.y-y)**2 < R*R){ kill(c,'disaster'); k++; } }
    for (const p of S.plants){ if ((p.x-x)**2+(p.y-y)**2 < R*R) p.e = 0; }
    fx('meteor', x, y, R);
    logEvent('Meteor killed '+k+' creatures');
  }},
  plague:  {name:'Plague', icon:'🦠', dur:400, growth:1, temp:0, col:'#a3e635'}
};
function triggerEvent(key){
  const e = EVENTS[key];
  S.env.event = key; S.env.eventLeft = e.dur;
  if (e.start) e.start();
  logEvent(e.icon+' <b>'+e.name+'</b> began');
}
let logDirty = true;
function logEvent(msg){ S.log.unshift({t:S.t, msg}); if (S.log.length>30) S.log.pop(); logDirty = true; }

function kill(c, cause){
  if (c.dead) return;
  c.dead = true; c.cause = cause; S.deaths++; S.deathsBy[cause] = (S.deathsBy[cause]||0)+1;
  fx('death', c.x, c.y, c, cause);
  if (cause!=='eaten' && rand()<0.5) addPlant(c.x + randn()*8, c.y + randn()*8, 4 + c.r);
}

/* ===================== SPATIAL HASH ===================== */
function rebuildGrid(grid, items){
  for (let i=0;i<grid.length;i++) grid[i].length = 0;
  for (const it of items){
    const gx = clamp((it.x/CS)|0, 0, HGW-1), gy = clamp((it.y/CS)|0, 0, HGH-1);
    grid[gy*HGW+gx].push(it);
  }
}
let lastD2 = 0;
function nearestPlant(x,y,range){
  const r2 = range*range; let best=null, bd=r2;
  const x0=Math.max(0,((x-range)/CS)|0), x1=Math.min(HGW-1,((x+range)/CS)|0);
  const y0=Math.max(0,((y-range)/CS)|0), y1=Math.min(HGH-1,((y+range)/CS)|0);
  for (let gy=y0;gy<=y1;gy++) for (let gx=x0;gx<=x1;gx++){
    const b = pGrid[gy*HGW+gx];
    for (let i=0;i<b.length;i++){ const p=b[i]; if (p.e<0.5) continue; const dx=p.x-x, dy=p.y-y, d=dx*dx+dy*dy; if (d<bd){bd=d;best=p;} }
  }
  lastD2 = bd; return best;
}
function nearestCreature(c,range){
  const x=c.x,y=c.y, r2 = range*range; let best=null, bd=r2;
  const x0=Math.max(0,((x-range)/CS)|0), x1=Math.min(HGW-1,((x+range)/CS)|0);
  const y0=Math.max(0,((y-range)/CS)|0), y1=Math.min(HGH-1,((y+range)/CS)|0);
  for (let gy=y0;gy<=y1;gy++) for (let gx=x0;gx<=x1;gx++){
    const b = cGrid[gy*HGW+gx];
    for (let i=0;i<b.length;i++){ const o=b[i]; if (o===c||o.dead||(c.pred&&o.pred&&o.lineage===c.lineage)) continue; const dx=o.x-x, dy=o.y-y, d=dx*dx+dy*dy; if (d<bd){bd=d;best=o;} }
  }
  lastD2 = bd; return best;
}
function findMate(c){
  const x=c.x,y=c.y, R=60;
  const x0=Math.max(0,((x-R)/CS)|0), x1=Math.min(HGW-1,((x+R)/CS)|0);
  const y0=Math.max(0,((y-R)/CS)|0), y1=Math.min(HGH-1,((y+R)/CS)|0);
  let best=null, bd=0.45;
  for (let gy=y0;gy<=y1;gy++) for (let gx=x0;gx<=x1;gx++){
    for (const o of cGrid[gy*HGW+gx]){
      if (o===c||o.dead||o.age<o.maturity) continue;
      if ((o.x-x)**2+(o.y-y)**2 > R*R) continue;
      const d = genomeDist(c.g,o.g); if (d<bd){bd=d;best=o;}
    }
  }
  return best;
}

/* ===================== SIMULATION TICK ===================== */
function updateEnv(){
  const E = S.env;
  const ph = (S.t % YEAR)/YEAR;
  E.season = (ph*4)|0; E.year = 1 + Math.floor(S.t/YEAR); E.phase = ph;
  // day/night: sun up ~60% of the day; daylight eases 0..1
  const dp = (S.t % DAY)/DAY; E.dayPhase = dp;
  const sun = Math.sin(dp*2*Math.PI);
  E.daylight = CFG.dayNight ? clamp(0.5 + sun*1.4, 0, 1) : 1;
  let temp = Math.cos((ph-0.375)*2*Math.PI)*0.7 + (CFG.dayNight ? sun*0.08 : 0);
  let growth = Math.max(0.22, 0.68 + 0.48*Math.cos((ph-0.22)*2*Math.PI));
  if (E.event){
    const ev = EVENTS[E.event];
    temp += ev.temp; growth *= ev.growth;
    if (--E.eventLeft <= 0){ logEvent(ev.icon+' '+ev.name+' ended'); E.event = null; }
  } else if (rand() < 1/3200){
    const keys = ['drought','bloom','coldsnap','heatwave','meteor','plague'];
    triggerEvent(keys[(rand()*keys.length)|0]);
  }
  E.temp = clamp(temp,-1.2,1.2);
  E.growth = growth;
  for (const h of S.hotspots){
    h.x += h.vx; h.y += h.vy;
    if (h.x<0||h.x>W) h.vx*=-1; if (h.y<0||h.y>H) h.vy*=-1;
    h.vx += randn()*0.004; h.vy += randn()*0.004; h.vx=clamp(h.vx,-0.25,0.25); h.vy=clamp(h.vy,-0.25,0.25);
  }
}
function growPlants(){
  const g = S.env.growth * CFG.food;
  const ge = 0.045*g;
  for (const p of S.plants){ if (p.e < PLANT_MAX_E) p.e = Math.min(PLANT_MAX_E, p.e + ge); }
  S.plantAcc += 2.4 * g;
  while (S.plantAcc >= 1){ S.plantAcc -= 1; const [x,y]=plantSpot(); addPlant(x,y,4); }
  if (S.env.event==='drought'){ for (const p of S.plants) if (rand()<0.002) p.e = 0; }
}

function stepCreature(c){
  const g = c.g, E = S.env;
  const vis = g.vision * (0.72 + 0.28*E.daylight);   // harder to see at night
  const inp = c.inp, ca = Math.cos(c.a), sa = Math.sin(c.a);
  const food = nearestPlant(c.x, c.y, vis); const fd2 = lastD2;
  if (food){ const dx=food.x-c.x, dy=food.y-c.y, d=Math.sqrt(fd2)||1; inp[0]=(-dx*sa+dy*ca)/d; inp[1]=(dx*ca+dy*sa)/d; inp[2]=1-d/vis; }
  else { inp[0]=0; inp[1]=0; inp[2]=0; }
  const o = nearestCreature(c, vis); const od2 = lastD2;
  if (o){ const dx=o.x-c.x, dy=o.y-c.y, d=Math.sqrt(od2)||1; inp[3]=(-dx*sa+dy*ca)/d; inp[4]=(dx*ca+dy*sa)/d; inp[5]=1-d/vis;
    inp[6]=clamp((o.r-c.r)/c.r,-1,1); inp[7]=inp[3]*clamp((o.g.diet-g.diet)*1.5,-1,1)*(0.5+inp[5]); }
  else { inp[3]=inp[4]=inp[5]=inp[6]=inp[7]=0; }
  inp[8] = c.energy/c.maxE;
  inp[9] = E.temp;
  const look = Math.min(60, g.vision*0.5);
  inp[10] = isWall(c.x+ca*look, c.y+sa*look) ? 1 : (isWall(c.x+ca*look*0.5, c.y+sa*look*0.5) ? 1 : 0);
  inp[11] = Math.sin(c.age*0.06 + c.id);
  c.food = food; c.target = o;
  forward(c.w, inp, c.hid, c.out);
  const out = c.out;
  c.a += out[0]*0.2;
  const tv = (out[1]+1)*0.5*c.maxSpeed;
  c.v += (tv - c.v)*0.25;
  const nx = c.x + Math.cos(c.a)*c.v, ny = c.y + Math.sin(c.a)*c.v;
  if (isWall(nx,ny)){ c.a += Math.PI*(0.6+rand()*0.8); c.v *= 0.3; }
  else { c.x = nx; c.y = ny; }
  c.phase += 0.12 + c.v*0.22;
  const sz = g.size;
  let cost = (0.03 + 0.0012*sz*sz) * g.metab * (0.75 + 0.25*g.lifespan);
  cost += 0.0018 * c.v*c.v * sz;
  cost += 0.00012 * g.vision;
  const T = E.temp, sf = Math.sqrt(8/sz);
  cost += (Math.max(0,-T)*(1-g.coat) + Math.max(0,T)*g.coat*0.8) * 0.085 * sf;
  c.attacking = 0;
  if (food && c.plantEff>0.02 && fd2 < (c.r+4)*(c.r+4)){
    const bite = Math.min(food.e, 1.5 + sz*0.3);
    food.e -= bite; c.energy += bite * c.plantEff * 2.2;
    if (c.ate<=0) fx('eat', food.x, food.y, c);
    c.ate = 8;
  }
  if (out[2] > 0){
    cost += 0.004*sz*out[2];
    c.attacking = out[2];
    if (o && od2 < (c.r+o.r+5)*(c.r+o.r+5)){
      const dmg = sz * (0.25 + g.diet) * 0.9 * out[2] * (0.12 + 0.88*c.meatEff);
      o.hp -= dmg * (o.r < c.r ? 1.2 : 0.7) * (o.pred && c.pred ? (o.lineage===c.lineage ? 0 : 0.25) : 1);
      if (dmg>0.5) o.hurt = 6;
      if (o.hp <= 0 && !o.dead){
        kill(o,'eaten'); c.kills++;
        c.energy += (o.energy*0.7 + o.g.size*o.g.size*2.0) * c.meatEff;
        c.ate = 12;
      }
    }
  }
  if (c.energy > c.maxE) c.energy = c.maxE;
  c.energy -= cost;
  c.hp = Math.min(c.maxHp, c.hp + 0.05);
  c.age++; if (c.cool>0) c.cool--; if (c.ate>0) c.ate--; if (c.hurt>0) c.hurt--;
  if (E.event==='plague'){
    const b = cGrid[clamp((c.y/CS)|0,0,HGH-1)*HGW + clamp((c.x/CS)|0,0,HGW-1)].length;
    if (rand() < 0.0005*Math.max(0,b-3)) { kill(c,'disaster'); return; }
  }
  if (c.energy <= 0){ kill(c,'starved'); return; }
  if (c.age > c.maxAge){ kill(c,'old'); return; }
  if (c.age > c.maturity && c.cool===0 && c.energy > g.repro*c.maxE && S.creatures.length + S.newborn.length < CFG.maxPop){
    let cg, cw;
    const mate = CFG.sexual ? findMate(c) : null;
    if (mate){ const x = crossover(c.g,c.w,mate.g,mate.w); cg=x.g; cw=x.w; mate.children++; }
    else { cg = c.g; cw = c.w; }
    cg = mutateGenes(cg, CFG.mut); cw = mutateBrain(cw, CFG.mut);
    let bx = c.x + randn()*c.r*1.5, by = c.y + randn()*c.r*1.5;
    if (isWall(bx,by)){ bx=c.x; by=c.y; }
    const kid = new Creature(cg, cw, bx, by, Math.max(c.gen, mate?mate.gen:0)+1, c.lineage);
    const give = c.energy*0.48;
    c.energy -= give*1.08; kid.energy = Math.min(kid.maxE, give);
    c.children++; c.cool = 200;
    S.newborn.push(kid); S.births++;
    fx('birth', bx, by, kid);
    if (kid.gen > S.maxGen) S.maxGen = kid.gen;
  }
}

function speciesCount(){
  const leaders = []; const counts = [];
  const cs = S.creatures; const step = Math.max(1, Math.floor(cs.length/400));
  for (let i=0;i<cs.length;i+=step){
    const c = cs[i]; let found=-1;
    for (let j=0;j<leaders.length;j++){ if (genomeDist(c.g, leaders[j].g) < 0.4){ found=j; break; } }
    if (found<0){ leaders.push(c); counts.push(1); } else counts[found]++;
  }
  return counts.filter(n=>n>=3).length;
}

function tick(){
  S.t++;
  updateEnv();
  growPlants();
  rebuildGrid(pGrid, S.plants);
  rebuildGrid(cGrid, S.creatures);
  S.newborn = [];
  const cs = S.creatures;
  for (let i=0;i<cs.length;i++){ const c=cs[i]; if (!c.dead) stepCreature(c); }
  for (const c of cs){
    if (c.age > S.oldestEver.age){ S.oldestEver = {name:c.name, age:c.age, id:c.id}; }
    if (c.children > S.bestEver.children){ S.bestEver = {name:c.name, children:c.children, id:c.id}; }
  }
  S.creatures = cs.filter(c=>!c.dead).concat(S.newborn);
  if (S.t % 4 === 0) S.plants = S.plants.filter(p=>p.e>=0.5);
  if (CFG.respawn && S.t % 20 === 0){
    let h=0,p=0; for (const c of S.creatures){ if (c.pred) p++; else h++; }
    if (h < 6){ for (let i=0;i<12;i++) spawnCreature(0.08+rand()*0.12); S.extinctions++; logEvent('Herbivores nearly extinct — 12 migrants arrived'); }
    if (p < 2 && h > 60 && S.t % 600 === 0){ for (let i=0;i<5;i++) spawnCreature(0.85+rand()*0.1); logEvent('Predators wandered in (5 migrants)'); }
  }
  if (S.t % S.histEvery === 0) recordStats();
  if (S.t % 90 === 0) S.species = speciesCount();
}

function recordStats(){
  let h=0,p=0; const sum = {speed:0,size:0,vision:0,diet:0,coat:0,metab:0};
  for (const c of S.creatures){ if (c.pred) p++; else h++; for (const k in sum) sum[k]+=gnorm(c.g,k); }
  const n = Math.max(1,S.creatures.length);
  const rec = {t:S.t, h, p, pl:S.plants.length};
  for (const k in sum) rec[k] = sum[k]/n;
  S.hist.push(rec);
  if (S.hist.length > 700){ S.hist = S.hist.filter((_,i)=>i%2===0); S.histEvery *= 2; }
}
