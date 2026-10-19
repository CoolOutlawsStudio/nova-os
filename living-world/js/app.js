/* UI, input (mouse + touch), camera, overlay, 2D fallback renderer, main loop. */
'use strict';
const $ = id => document.getElementById(id);
const store = { get(k,d){ try { const v = window.localStorage && localStorage.getItem('lw.'+k); return v===null||v===undefined?d:JSON.parse(v); } catch(e){ return d; } },
                set(k,v){ try { window.localStorage && localStorage.setItem('lw.'+k, JSON.stringify(v)); } catch(e){} } };

const glCanvas = $('gl'), c2d = $('c2d'), ov = $('overlay'), octx = ov.getContext('2d');
let ctx2d = null;
let dpr = 1, vw = 0, vh = 0, glScale = 1, lowFps = 0, highFps = 0;
let cam = {x:W/2, y:H/2, z:0.5}, camT = {x:W/2, y:H/2, z:0.5};
let selected = null, following = false, lastSelectedInfo = '';
let tool = 'inspect', brush = 50, running = true, speed = 2;
const OPT = { bloom: store.get('bloom', true), weather: store.get('weather', true), mini: true, vision:false };
let useGL = false;
let FIXEDRES = false; try { FIXEDRES = /fixedres/.test(location.search); } catch(e){}
const mouse = {x:-1,y:-1,wx:0,wy:0,inside:false};

/* ---------- smoothed visual state (for gentle transitions) ---------- */
const VS = { drought:0, frost:0, wet:0, heat:0, seasonF:0, amb:[1,1,1], grade:[1,1,1], plant:[0.4,0.85,0.4] };
const approach = (a,b,k)=>a+(b-a)*k;

function resize(){
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  vw = window.innerWidth; vh = window.innerHeight;
  for (const c of [c2d, ov]){ c.width = Math.round(vw*dpr); c.height = Math.round(vh*dpr); }
  glCanvas.width = Math.max(1, Math.round(vw*dpr*glScale)); glCanvas.height = Math.max(1, Math.round(vh*dpr*glScale));
  for (const id of ['popchart','traitchart','brain','mini']){ const c=$(id); if (c.clientWidth){ c.width=c.clientWidth*dpr; c.height=c.clientHeight*dpr; } }
}
function fitView(immediate){
  const mobile = vw < 820;
  const availW = mobile || panelHidden ? vw : vw - 380;
  camT.z = Math.min(availW/(W+60), (vh-90)/(H+60));
  camT.x = W/2 + (mobile||panelHidden ? 0 : 380/2/camT.z); camT.y = H/2 + 20/camT.z;
  following=false; updateFollowBtn();
  if (immediate) Object.assign(cam, camT);
}
const toWorld = (sx,sy)=>[(sx-vw/2)/cam.z + cam.x, (sy-vh/2)/cam.z + cam.y];

/* ---------- lighting / atmosphere ---------- */
const DAYC=[1.0,0.97,0.92], DUSK=[1.0,0.78,0.62], NIGHT=[0.31,0.33,0.44];
function mix3(a,b,t){ return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t]; }
const SEASON_PLANT = [[0.38,0.86,0.42],[0.58,0.86,0.30],[0.96,0.58,0.22],[0.62,0.88,0.84]];
function atmosphere(k){
  const E = S.env, d = E.daylight, ev = E.event;
  let amb = d > 0.5 ? mix3(DUSK, DAYC, (d-0.5)*2) : mix3(NIGHT, DUSK, d*2);
  let grade = [1,1,1];
  if (ev==='drought'){ amb = [amb[0]*1.06, amb[1]*1.0, amb[2]*0.86]; grade=[1.05,1.0,0.9]; }
  if (ev==='coldsnap'){ amb = [amb[0]*0.95, amb[1]*0.98, amb[2]*1.05]; grade=[0.98,0.99,1.03]; }
  if (ev==='heatwave'){ amb = [amb[0]*1.1, amb[1]*0.96, amb[2]*0.82]; grade=[1.08,0.98,0.88]; }
  if (ev==='plague'){ grade=[0.95,1.05,0.9]; }
  if (ev==='bloom'){ grade=[1.03,1.0,1.04]; amb = [amb[0]*0.95, amb[1]*0.97, amb[2]*1.02]; }
  VS.amb = mix3(VS.amb, amb, k); VS.grade = mix3(VS.grade, grade, k);
  const winterish = E.season===3;
  VS.drought = approach(VS.drought, ev==='drought'?1:0, k*0.5);
  VS.frost = approach(VS.frost, ev==='coldsnap'?1:0, k*0.5);
  const rainy = ev==='bloom' || (E.season===0 && (Math.floor(S.t/DAY)%3===1));
  VS.wet = approach(VS.wet, rainy?1:0, k*0.4);
  VS.heat = approach(VS.heat, ev==='heatwave'?1:ev==='drought'?0.5:0, k*0.5);
  let sf = E.phase*4; if (sf - VS.seasonF < -2) VS.seasonF -= 4; VS.seasonF = approach(VS.seasonF, sf, 0.2);
  let pc = SEASON_PLANT[E.season]; if (ev==='drought') pc = [0.78,0.68,0.32]; if (ev==='bloom') pc=[0.45,0.95,0.5];
  VS.plant = mix3(VS.plant, pc, k*0.5); _plantRGB = VS.plant;
  const sunA = (E.dayPhase||0)*Math.PI*2; const sun = Math.sin(sunA);
  let lx = Math.cos(sunA), ly = -0.55 - 0.45*Math.max(0,sun); const ln = Math.hypot(lx,ly); lx/=ln; ly/=ln;
  if (!CFG.dayNight){ lx=-0.6; ly=-0.8; }
  return { ambient:VS.amb, dir:[lx,ly], shadowLen: CFG.dayNight ? 0.5 + (1-Math.max(0,sun))*1.3 : 0.8 };
}

/* ---------- 2D fallback renderer ---------- */
function render2D(V){
  const ctx = ctx2d; const E = S.env;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.fillStyle = '#05070b'; ctx.fillRect(0,0,vw,vh);
  ctx.save(); ctx.translate(vw/2, vh/2); ctx.scale(V.cam.z, V.cam.z); ctx.translate(-V.cam.x, -V.cam.y);
  const a = V.light.ambient, sp = SEASON_PLANT[E.season];
  ctx.fillStyle = `rgb(${(40+sp[0]*30)*a[0]|0},${(55+sp[1]*30)*a[1]|0},${(40+sp[2]*20)*a[2]|0})`; ctx.fillRect(0,0,W,H);
  for (const h of S.hotspots){ const g = ctx.createRadialGradient(h.x,h.y,0,h.x,h.y,h.r*1.3); g.addColorStop(0,'rgba(90,200,110,0.15)'); g.addColorStop(1,'rgba(90,200,110,0)'); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(h.x,h.y,h.r*1.3,0,7); ctx.fill(); }
  ctx.fillStyle = `rgb(${VS.plant[0]*200*a[0]|0},${VS.plant[1]*200*a[1]|0},${VS.plant[2]*200*a[2]|0})`; ctx.beginPath();
  for (const p of S.plants){ if (p.e<0.5) continue; const r = 1.5+p.e*0.12; ctx.moveTo(p.x+r,p.y); ctx.arc(p.x,p.y,r,0,6.283); } ctx.fill();
  ctx.fillStyle = '#5a5550';
  for (let gy=0;gy<GH;gy++) for (let gx=0;gx<GW;gx++) if (walls[gy*GW+gx]) ctx.fillRect(gx*WCELL,gy*WCELL,WCELL,WCELL);
  for (const c of S.creatures){
    const r=c.r, ca=Math.cos(c.a), sa=Math.sin(c.a);
    ctx.fillStyle = c.col; ctx.beginPath();
    if (c.pred){ ctx.moveTo(c.x+ca*r*1.6,c.y+sa*r*1.6); ctx.lineTo(c.x-ca*r*0.9-sa*r,c.y-sa*r*0.9+ca*r); ctx.lineTo(c.x-ca*r*0.4,c.y-sa*r*0.4); ctx.lineTo(c.x-ca*r*0.9+sa*r,c.y-sa*r*0.9-ca*r); ctx.closePath(); }
    else ctx.ellipse(c.x,c.y,r*1.15,r*0.85,c.a,0,6.283);
    ctx.fill(); ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(c.x+ca*r*0.75,c.y+sa*r*0.75,Math.max(0.9,r*0.22),0,6.283); ctx.fill();
  }
  ctx.globalCompositeOperation='lighter';
  for (let i=0;i<P.n;i++){ const k=P.life[i]/P.max[i]; ctx.fillStyle=`rgba(${P.r[i]*255|0},${P.g[i]*255|0},${P.b[i]*255|0},${P.a[i]*(1-k)*0.8})`; ctx.fillRect(P.x[i]-P.size[i]*0.5,P.y[i]-P.size[i]*0.5,P.size[i],P.size[i]); }
  ctx.globalCompositeOperation='source-over';
  ctx.restore();
}

/* ---------- overlay (selection, vision, brush) ---------- */
function drawOverlay(V, now){
  octx.setTransform(dpr,0,0,dpr,0,0); octx.clearRect(0,0,vw,vh);
  octx.save(); octx.translate(vw/2, vh/2); octx.scale(V.cam.z, V.cam.z); octx.translate(-V.cam.x, -V.cam.y);
  const lw = 1/V.cam.z;
  if (OPT.vision){ octx.strokeStyle='rgba(255,255,255,0.07)'; octx.lineWidth=lw; octx.beginPath(); for (const c of S.creatures){ octx.moveTo(c.x+c.g.vision,c.y); octx.arc(c.x,c.y,c.g.vision,0,6.2832);} octx.stroke(); }
  if (selected && !selected.dead){
    const c = selected, vis = c.g.vision*(0.72+0.28*S.env.daylight);
    const grd = octx.createRadialGradient(c.x,c.y,vis*0.2,c.x,c.y,vis); grd.addColorStop(0,'rgba(253,230,138,0.0)'); grd.addColorStop(1,'rgba(253,230,138,0.07)');
    octx.fillStyle = grd; octx.beginPath(); octx.arc(c.x,c.y,vis,0,6.2832); octx.fill();
    octx.strokeStyle='rgba(253,230,138,0.35)'; octx.lineWidth=1.2*lw; octx.setLineDash([6*lw,6*lw]); octx.lineDashOffset = -now*0.02*lw; octx.stroke(); octx.setLineDash([]);
    if (c.food && c.food.e>0.5){ octx.strokeStyle='rgba(134,239,172,0.7)'; octx.lineWidth=1.5*lw; octx.beginPath(); octx.moveTo(c.x,c.y); octx.lineTo(c.food.x,c.food.y); octx.stroke(); }
    if (c.target && !c.target.dead){ octx.strokeStyle= c.pred ? 'rgba(248,113,113,0.8)' : 'rgba(147,197,253,0.6)'; octx.lineWidth=1.5*lw; octx.setLineDash([4*lw,4*lw]); octx.beginPath(); octx.moveTo(c.x,c.y); octx.lineTo(c.target.x,c.target.y); octx.stroke(); octx.setLineDash([]); }
    const pulse = 1 + 0.12*Math.sin(now/170);
    octx.strokeStyle='rgba(253,230,138,0.95)'; octx.lineWidth=2*lw; octx.shadowColor='rgba(253,230,138,0.8)'; octx.shadowBlur=10;
    octx.beginPath(); octx.arc(c.x,c.y,(c.r*2.0+5)*pulse,0,6.2832); octx.stroke(); octx.shadowBlur=0;
    // name tag
    octx.font = `${12*lw}px system-ui`; octx.textAlign='center';
    const label = c.name + (c.pred?' 🐺':' 🐇');
    const tw = octx.measureText(label).width + 12*lw, ty = c.y - c.r*2.4 - 14*lw;
    octx.fillStyle='rgba(10,14,22,0.7)'; roundRect(octx, c.x-tw/2, ty-11*lw, tw, 16*lw, 6*lw); octx.fill();
    octx.fillStyle='#fde68a'; octx.fillText(label, c.x, ty+1*lw);
    const ef = clamp(c.energy/c.maxE,0,1); octx.fillStyle='rgba(10,14,22,0.7)'; octx.fillRect(c.x-14*lw, ty+7*lw, 28*lw, 3*lw); octx.fillStyle='#fbbf24'; octx.fillRect(c.x-14*lw, ty+7*lw, 28*lw*ef, 3*lw);
  }
  if (mouse.inside && tool!=='inspect' && !isTouch){
    octx.strokeStyle = {food:'#86efac',herb:'#4ade80',pred:'#f87171',smite:'#c4b5fd',wall:'#cbd5e1',erase:'#fbbf24'}[tool];
    octx.lineWidth = 1.5*lw; octx.setLineDash([5*lw,4*lw]);
    const rr = (tool==='herb'||tool==='pred') ? 10 : brush;
    octx.beginPath(); octx.arc(mouse.wx, mouse.wy, rr, 0, 6.2832); octx.stroke(); octx.setLineDash([]);
  }
  octx.restore();
}
function roundRect(c,x,y,w,h,r){ c.beginPath(); c.moveTo(x+r,y); c.arcTo(x+w,y,x+w,y+h,r); c.arcTo(x+w,y+h,x,y+h,r); c.arcTo(x,y+h,x,y,r); c.arcTo(x,y,x+w,y,r); c.closePath(); }

/* ---------- minimap ---------- */
const miniCv = $('mini'), mctx = miniCv.getContext('2d');
function drawMini(){
  if (!OPT.mini || !miniCv.width) return;
  const w = miniCv.width, h = miniCv.height, sx = w/W, sy = h/H;
  mctx.fillStyle = '#122016'; mctx.fillRect(0,0,w,h);
  for (const hs of S.hotspots){ const g = mctx.createRadialGradient(hs.x*sx,hs.y*sy,0,hs.x*sx,hs.y*sy,hs.r*sx*1.3); g.addColorStop(0,'rgba(80,190,100,0.35)'); g.addColorStop(1,'rgba(80,190,100,0)'); mctx.fillStyle=g; mctx.fillRect(0,0,w,h); }
  mctx.fillStyle = '#6b665f';
  for (let gy=0;gy<GH;gy++) for (let gx=0;gx<GW;gx++) if (walls[gy*GW+gx]) mctx.fillRect(gx*WCELL*sx, gy*WCELL*sy, WCELL*sx+0.5, WCELL*sy+0.5);
  for (const c of S.creatures){ mctx.fillStyle = c.pred ? '#f87171' : '#86efac'; const s = c.pred?2.5*dpr:1.6*dpr; mctx.fillRect(c.x*sx-s/2, c.y*sy-s/2, s, s); }
  const x0 = (cam.x - vw/2/cam.z)*sx, y0 = (cam.y - vh/2/cam.z)*sy;
  mctx.strokeStyle = 'rgba(255,255,255,0.8)'; mctx.lineWidth = 1.2*dpr; mctx.strokeRect(x0, y0, vw/cam.z*sx, vh/cam.z*sy);
}
$('minimap').addEventListener('pointerdown', e=>{ const r = miniCv.getBoundingClientRect(); camT.x = (e.clientX-r.left)/r.width*W; camT.y = (e.clientY-r.top)/r.height*H; following=false; updateFollowBtn(); e.stopPropagation(); });

/* ---------- charts / inspector / records ---------- */
const TRAIT_COLS = {speed:'#60a5fa', size:'#fbbf24', vision:'#c084fc', diet:'#f87171', coat:'#e2e8f0', metab:'#34d399'};
$('traitlegend').innerHTML = Object.keys(TRAIT_COLS).map(k=>`<span><i style="background:${TRAIT_COLS[k]}"></i>${GLABEL[k]}</span>`).join('');
function drawChart(id, series, maxOverride){
  const c = $(id), g = c.getContext('2d');
  const w = c.width, h = c.height; g.clearRect(0,0,w,h);
  const hist = S.hist; if (hist.length<2 || !w) return;
  g.strokeStyle='rgba(255,255,255,0.05)'; g.lineWidth=1;
  for (let i=1;i<4;i++){ g.beginPath(); g.moveTo(0,h*i/4); g.lineTo(w,h*i/4); g.stroke(); }
  const t0 = hist[0].t, t1 = hist[hist.length-1].t, span = Math.max(1,t1-t0);
  for (let yr = Math.floor(t0/YEAR)*YEAR; yr < t1; yr += YEAR){
    const xs = (yr+YEAR*0.75 - t0)/span*w, xe = (yr+YEAR - t0)/span*w;
    g.fillStyle='rgba(147,197,253,0.07)'; g.fillRect(xs,0,xe-xs,h);
  }
  let max = maxOverride || 1;
  if (!maxOverride) for (const s of series){ if (s.own) continue; for (const r of hist) max = Math.max(max, r[s.k]); }
  for (const s of series){
    let m = max; if (s.own){ m=1; for (const r of hist) m=Math.max(m,r[s.k]); }
    const pts = hist.map(r=>[(r.t-t0)/span*w, h - 3*dpr - (r[s.k]/m)*(h-8*dpr)]);
    if (s.fill){ const gr = g.createLinearGradient(0,0,0,h); gr.addColorStop(0, s.fill); gr.addColorStop(1,'rgba(0,0,0,0)'); g.fillStyle=gr; g.beginPath(); g.moveTo(pts[0][0],h); pts.forEach(p=>g.lineTo(p[0],p[1])); g.lineTo(pts[pts.length-1][0],h); g.closePath(); g.fill(); }
    g.strokeStyle = s.col; g.lineWidth = (s.w||1.7)*dpr; g.lineJoin='round'; g.beginPath();
    pts.forEach((p,i)=> i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1])); g.stroke();
  }
  if (!maxOverride){ g.fillStyle='#8a97b0'; g.font=`${10*dpr}px system-ui`; g.fillText(String(Math.round(max)), 4*dpr, 11*dpr); }
}
function drawBrain(c){
  const cvb = $('brain'), g = cvb.getContext('2d');
  const w = cvb.width, h = cvb.height; if (!w) return; g.clearRect(0,0,w,h);
  const lx = [62*dpr, w/2+10*dpr, w-62*dpr];
  const layers = [Array.from(c.inp), Array.from(c.hid), Array.from(c.out)];
  const pos = layers.map((L,li)=>L.map((_,i)=>[lx[li], (i+0.5)*(h/L.length)]));
  g.lineWidth = 1*dpr;
  for (let hh=0;hh<NH;hh++) for (let i=0;i<NI;i++){
    const v = c.w[iW1(i,hh)]*layers[0][i]; if (Math.abs(v)<0.3) continue;
    g.strokeStyle = v>0 ? `rgba(110,231,183,${Math.min(0.8,Math.abs(v)/3)})` : `rgba(248,113,113,${Math.min(0.8,Math.abs(v)/3)})`;
    g.beginPath(); g.moveTo(...pos[0][i]); g.lineTo(...pos[1][hh]); g.stroke();
  }
  for (let o=0;o<NO;o++) for (let hh=0;hh<NH;hh++){
    const v = c.w[iW2(hh,o)]*layers[1][hh]; if (Math.abs(v)<0.2) continue;
    g.strokeStyle = v>0 ? `rgba(110,231,183,${Math.min(0.9,Math.abs(v)/2)})` : `rgba(248,113,113,${Math.min(0.9,Math.abs(v)/2)})`;
    g.beginPath(); g.moveTo(...pos[1][hh]); g.lineTo(...pos[2][o]); g.stroke();
  }
  g.font = `${9*dpr}px system-ui`;
  layers.forEach((L,li)=>L.forEach((v,i)=>{
    const [x,y] = pos[li][i]; const a = clamp(v,-1,1);
    g.fillStyle = a>=0 ? `rgb(${40+a*70|0},${60+a*171|0},${70+a*113|0})` : `rgb(${60-a*188|0},${50-a*63|0},${60-a*53|0})`;
    g.shadowColor = g.fillStyle; g.shadowBlur = 6*dpr*Math.abs(a);
    g.beginPath(); g.arc(x,y,(li===1?4:4.5)*dpr,0,6.2832); g.fill(); g.shadowBlur=0;
    g.fillStyle='#9aa6bd';
    if (li===0){ g.textAlign='right'; g.fillText(IN_LABELS[i], x-7*dpr, y+3*dpr); }
    if (li===2){ g.textAlign='left'; g.fillText(OUT_LABELS[i]+' '+v.toFixed(2), x+8*dpr, y+3*dpr); }
  }));
  g.textAlign='left';
}
const creatureLink = (id,name)=>`<span class="link" data-sel="${id}">${name}</span>`;
const fmtT = t => t>=1000 ? (t/1000).toFixed(1)+'k' : String(Math.round(t));
let lastEvent = null, bannerTimer = 0;
function banner(html){ const b=$('banner'); b.innerHTML = html; b.classList.add('show'); clearTimeout(bannerTimer); bannerTimer = setTimeout(()=>b.classList.remove('show'), 2600); }
function updateUI(){
  const E = S.env;
  let h=0,p=0; for (const c of S.creatures){ if (c.pred) p++; else h++; }
  const tod = E.daylight>0.75?'☀':E.daylight>0.25?'🌇':'🌙';
  $('seasonchip').innerHTML = `${SEASON_ICON[E.season]} <b>${SEASONS[E.season]}</b> · Year ${E.year} · ${CFG.dayNight?tod:''}`;
  $('tempchip').innerHTML = `🌡 <b>${(14 + E.temp*18).toFixed(0)}°C</b> · growth ${(E.growth*CFG.food).toFixed(2)}x`;
  $('popchip').innerHTML = `<span style="color:#4ade80">●</span> <b>${h}</b> · <span style="color:#f87171">●</span> <b>${p}</b> · 🌿 ${S.plants.length} · ${S.species} species`;
  const evc = $('evchip');
  if (E.event){ const ev = EVENTS[E.event]; evc.classList.add('show'); evc.innerHTML = `${ev.icon} <b style="color:${ev.col}">${ev.name}</b> · ${E.eventLeft}`; } else evc.classList.remove('show');
  if (E.event !== lastEvent){ if (E.event){ const ev=EVENTS[E.event]; banner(`${ev.icon} <span style="color:${ev.col}">${ev.name}</span>`); } lastEvent = E.event; }
  $('pausechip').style.display = running ? 'none' : 'block';
  $('tickv').textContent = S.t.toLocaleString();
  if (panelHidden) return;
  drawChart('popchart', [{k:'pl',col:'#3f6a46',own:true,w:1.2},{k:'h',col:'#4ade80',fill:'rgba(74,222,128,0.18)'},{k:'p',col:'#f87171',fill:'rgba(248,113,113,0.18)'}]);
  if ($('traitchart').closest('details').open) drawChart('traitchart', Object.keys(TRAIT_COLS).map(k=>({k,col:TRAIT_COLS[k]})), 1);
  let oldest=null, prolific=null, big=null;
  for (const c of S.creatures){ if(!oldest||c.age>oldest.age) oldest=c; if(!prolific||c.children>prolific.children) prolific=c; if(!big||c.g.size>big.g.size) big=c; }
  const lin = {}; for (const c of S.creatures){ lin[c.lineageName]=(lin[c.lineageName]||0)+1; }
  const topLin = Object.entries(lin).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([n,k])=>`${n} (${k})`).join(', ');
  $('records').innerHTML = `
    <div>Generation (max)</div><div><b>${S.maxGen}</b></div>
    <div>Oldest living</div><div>${oldest?creatureLink(oldest.id,oldest.name)+' · '+fmtT(oldest.age)+' ticks':'-'}</div>
    <div>Most prolific</div><div>${prolific?creatureLink(prolific.id,prolific.name)+' · '+prolific.children+' kids':'-'}</div>
    <div>Largest living</div><div>${big?creatureLink(big.id,big.name)+' · size '+big.g.size.toFixed(1):'-'}</div>
    <div>All-time prolific</div><div>${S.bestEver.name} · ${S.bestEver.children} kids</div>
    <div>All-time oldest</div><div>${S.oldestEver.name} · ${fmtT(S.oldestEver.age)}</div>
    <div>Top lineages</div><div>${topLin||'-'}</div>
    <div>Births / deaths</div><div>${S.births.toLocaleString()} / ${S.deaths.toLocaleString()}</div>
    <div>Deaths by</div><div>starve ${S.deathsBy.starved} · age ${S.deathsBy.old} · eaten ${S.deathsBy.eaten} · other ${S.deathsBy.smitten+S.deathsBy.disaster}</div>
    <div>Rescues</div><div>${S.extinctions}</div>`;
  if (logDirty){ $('log').innerHTML = S.log.slice(0,12).map(l=>`<div>t${fmtT(l.t)} · ${l.msg}</div>`).join(''); logDirty=false; }
  updateInspector();
}
function updateInspector(){
  const box = $('insp'), empty = $('insp-empty');
  if (!selected){ box.style.display='none'; empty.style.display='block'; empty.textContent = lastSelectedInfo ? lastSelectedInfo+'. Tap another creature.' : 'Tap / click a creature to inspect it.'; return; }
  if (selected.dead){ lastSelectedInfo = `${selected.name} died (${selected.cause}) at age ${selected.age}, leaving ${selected.children} children`; selected=null; following=false; updateFollowBtn(); updateInspector(); return; }
  box.style.display='block'; empty.style.display='none';
  const c = selected, g = c.g;
  $('i-sw').style.background = c.col; $('i-sw').style.color = c.col;
  $('i-name').textContent = c.name + ' #' + c.id;
  $('i-type').textContent = c.pred ? '· predator' : (g.diet>0.3 ? '· omnivore' : '· herbivore');
  const bar = (v,col)=>`<span class="mb"><i style="width:${(clamp(v,0,1)*100).toFixed(0)}%;background:${col}"></i></span>`;
  $('i-kv').innerHTML = `
    <div>Energy</div><div>${bar(c.energy/c.maxE,'#fbbf24')}${c.energy.toFixed(0)} / ${c.maxE.toFixed(0)}</div>
    <div>Health</div><div>${bar(c.hp/c.maxHp,'#f87171')}${c.hp.toFixed(0)} / ${c.maxHp.toFixed(0)}</div>
    <div>Age</div><div>${bar(c.age/c.maxAge,'#60a5fa')}${c.age} / ${c.maxAge.toFixed(0)}</div>
    <div>Generation</div><div>${c.gen} · lineage <b>${c.lineageName}</b></div>
    <div>Children / kills</div><div>${c.children} / ${c.kills}</div>
    <div>Speed now</div><div>${c.v.toFixed(2)} / ${c.maxSpeed.toFixed(2)}</div>
    <div>Brain out</div><div>turn ${c.out[0].toFixed(2)} · thr ${c.out[1].toFixed(2)} · atk ${c.out[2].toFixed(2)}</div>`;
  $('i-genes').innerHTML = GKEYS.map(k=>{
    const n = gnorm(g,k);
    return `<div class="gbar"><span>${GLABEL[k]}</span><div class="b"><i style="width:${(n*100).toFixed(0)}%;background:${k==='hueA'?c.col:k==='diet'?'linear-gradient(90deg,#4ade80,#f87171)':'linear-gradient(90deg,#34d399,#60a5fa)'}"></i></div><span>${g[k].toFixed(2)}</span></div>`;
  }).join('');
  drawBrain(c);
}
function updateFollowBtn(){ const b=$('btnFollow'); b.classList.toggle('on',following); b.textContent = following?'Following':'Follow'; }

/* ---------- input ---------- */
let isTouch = false;
function pickCreature(wx,wy,px){
  let best=null, bd=(px/cam.z)**2;
  for (const c of S.creatures){ const d=(c.x-wx)**2+(c.y-wy)**2 - c.r*c.r*1.5; if (d<bd){bd=d;best=c;} }
  return best;
}
function select(c){ selected=c; lastSelectedInfo=''; if(!c){following=false;} updateFollowBtn(); updateInspector(); if (c && vw<820 && panelHidden) {} }
function paintWalls(wx,wy,val){
  const R = brush, x0=Math.max(0,((wx-R)/WCELL)|0), x1=Math.min(GW-1,((wx+R)/WCELL)|0), y0=Math.max(0,((wy-R)/WCELL)|0), y1=Math.min(GH-1,((wy+R)/WCELL)|0);
  for (let gy=y0;gy<=y1;gy++) for (let gx=x0;gx<=x1;gx++){ const cx=(gx+0.5)*WCELL, cy=(gy+0.5)*WCELL; if ((cx-wx)**2+(cy-wy)**2 <= R*R) walls[gy*GW+gx]=val; }
  if (val){ for (const p of S.plants) if (isWall(p.x,p.y)) p.e=0; for (const c of S.creatures) if (isWall(c.x,c.y)){ for(let k=0;k<20&&isWall(c.x,c.y);k++){ c.x=clamp(c.x+randn()*R*0.5,1,W-1); c.y=clamp(c.y+randn()*R*0.5,1,H-1);} } }
  wallsVersion++;
}
function applyTool(first, wx, wy){
  if (tool==='food'){ const n = Math.ceil(brush*brush/900); for (let i=0;i<n;i++){ const a=rand()*6.283, r=Math.sqrt(rand())*brush; addPlant(wx+Math.cos(a)*r, wy+Math.sin(a)*r, 15+rand()*15);} if (Math.random()<0.5) emit(1,wx,wy,0,0,20,brush*0.3,0.5,1,0.6,0.4,1,{grow:brush*0.04}); }
  else if (tool==='herb' && first){ if(!isWall(wx,wy)) spawnCreature(0.1+rand()*0.1, wx, wy); }
  else if (tool==='pred' && first){ if(!isWall(wx,wy)) spawnCreature(0.85+rand()*0.1, wx, wy); }
  else if (tool==='smite'){ let k=0; for (const c of S.creatures){ if (!c.dead && (c.x-wx)**2+(c.y-wy)**2 < brush*brush){ kill(c,'smitten'); k++; } } S.creatures = S.creatures.filter(c=>!c.dead); if (first||k){ for(let i=0;i<10;i++){ const a=Math.random()*6.283; emit(6,wx,wy,Math.cos(a)*3,Math.sin(a)*3,16,2,0.8,0.7,1,1,1,{drag:0.85}); } } }
  else if (tool==='wall') paintWalls(wx,wy,1);
  else if (tool==='erase') paintWalls(wx,wy,0);
}
function zoomAt(sx, sy, f, immediate){
  const wx = (sx - vw/2)/camT.z + camT.x, wy = (sy - vh/2)/camT.z + camT.y;
  camT.z = clamp(camT.z*f, 0.15, 8);
  if (!following){ camT.x = wx - (sx-vw/2)/camT.z; camT.y = wy - (sy-vh/2)/camT.z; }
  if (immediate){ cam.z = camT.z; if (!following){ cam.x = camT.x; cam.y = camT.y; } }
}
function panBy(dx, dy){ cam.x -= dx/cam.z; cam.y -= dy/cam.z; camT.x -= dx/cam.z; camT.y -= dy/cam.z; }
const ptrs = new Map(); let gesture = null;
ov.addEventListener('contextmenu', e=>e.preventDefault());
ov.addEventListener('pointerdown', e=>{
  if (e.pointerType==='touch') isTouch = true; else if (e.pointerType==='mouse') isTouch = false;
  ov.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, {x:e.clientX, y:e.clientY});
  if (ptrs.size === 2){
    const [a,b] = [...ptrs.values()];
    gesture = {mode:'pinch', d:Math.hypot(a.x-b.x,a.y-b.y), mx:(a.x+b.x)/2, my:(a.y+b.y)/2}; return;
  }
  if (ptrs.size > 2) return;
  const [wx,wy] = toWorld(e.clientX, e.clientY);
  if (e.button===1 || e.button===2){ gesture = {mode:'pan', lx:e.clientX, ly:e.clientY, moved:99}; return; }
  if (tool==='inspect') gesture = {mode:'tap', sx:e.clientX, sy:e.clientY, lx:e.clientX, ly:e.clientY, moved:0};
  else { gesture = {mode:'paint'}; applyTool(true, wx, wy); }
});
ov.addEventListener('pointermove', e=>{
  mouse.x=e.clientX; mouse.y=e.clientY; mouse.inside=true; [mouse.wx,mouse.wy]=toWorld(mouse.x,mouse.y);
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, {x:e.clientX, y:e.clientY});
  if (!gesture) return;
  if (gesture.mode==='pinch' && ptrs.size>=2){
    const [a,b] = [...ptrs.values()];
    const d = Math.hypot(a.x-b.x,a.y-b.y), mx=(a.x+b.x)/2, my=(a.y+b.y)/2;
    panBy(mx-gesture.mx, my-gesture.my);
    if (gesture.d>10) zoomAt(mx, my, d/gesture.d, true);
    gesture.d=d; gesture.mx=mx; gesture.my=my;
    if (following){ following=false; updateFollowBtn(); }
    return;
  }
  if (gesture.mode==='tap' || gesture.mode==='pan'){
    const dx = e.clientX-gesture.lx, dy = e.clientY-gesture.ly;
    gesture.moved += Math.abs(dx)+Math.abs(dy);
    if (gesture.mode==='tap' && gesture.moved > (isTouch?10:4)) gesture.mode='pan';
    if (gesture.mode==='pan'){ panBy(dx,dy); if (following && gesture.moved>8){ following=false; updateFollowBtn(); } }
    gesture.lx=e.clientX; gesture.ly=e.clientY;
  } else if (gesture.mode==='paint' && tool!=='herb' && tool!=='pred'){ applyTool(false, mouse.wx, mouse.wy); }
});
function endPtr(e){
  if (gesture && gesture.mode==='tap' && ptrs.size===1){
    const [wx,wy] = toWorld(e.clientX, e.clientY);
    const c = pickCreature(wx, wy, isTouch?26:16);
    if (c){ select(c); if (isTouch){ following=true; updateFollowBtn(); } } else select(null);
  }
  ptrs.delete(e.pointerId);
  if (ptrs.size===0) gesture=null;
  else if (gesture && gesture.mode==='pinch' && ptrs.size===1){ const [a]=[...ptrs.values()]; gesture={mode:'pan', lx:a.x, ly:a.y, moved:99}; }
}
ov.addEventListener('pointerup', endPtr); ov.addEventListener('pointercancel', endPtr);
ov.addEventListener('pointerleave', ()=>{ mouse.inside=false; });
ov.addEventListener('wheel', e=>{ e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY*0.0016), false); }, {passive:false});
window.addEventListener('keydown', e=>{
  if (e.target.tagName==='INPUT' && e.target.type==='text') return;
  if (e.code==='Space'){ e.preventDefault(); setRunning(!running); }
  else if (e.key==='.'){ setRunning(false); tick(); updateUI(); }
  else if (e.key==='f'||e.key==='F'){ if (selected){ following=!following; updateFollowBtn(); } }
  else if (e.key==='Escape'){ select(null); }
  else if (e.key>='1' && e.key<='7'){ setTool(['inspect','food','herb','pred','smite','wall','erase'][+e.key-1]); }
});
let panelHidden = false;
function setPanel(hidden){ panelHidden = hidden; $('panel').classList.toggle('hidden', hidden); $('btnPanel').classList.toggle('on', !hidden); if (!hidden) setTimeout(()=>{ resize(); updateUI(); }, 60); }
function setRunning(v){ running=v; const b=$('btnPlay'); b.classList.toggle('on',v); $('playIcon').innerHTML = v ? '<path d="M8 5v14M16 5v14"/>' : '<path d="M7 4l13 8-13 8z"/>'; $('pausechip').style.display = v ? 'none' : 'block'; }
function setTool(t){ tool=t; document.querySelectorAll('#dock button[data-tool]').forEach(b=>b.classList.toggle('on', b.dataset.tool===t)); ov.style.cursor = t==='inspect'?'default':'crosshair'; }
$('btnPlay').onclick = ()=>setRunning(!running);
$('btnStep').onclick = ()=>{ setRunning(false); tick(); updateUI(); };
$('btnFit').onclick = ()=>fitView(false);
$('btnPanel').onclick = ()=>setPanel(!panelHidden);
$('panelBtn').onclick = ()=>setPanel(!panelHidden);
$('btnReset').onclick = ()=>{ reset($('seed').value || 'gaia'); select(null); lastSelectedInfo=''; fitView(false); updateUI(); };
$('btnRand').onclick = ()=>{ const s = Math.random().toString(36).slice(2,8); $('seed').value=s; reset(s); select(null); fitView(false); updateUI(); };
$('btnClearWalls').onclick = ()=>{ walls.fill(0); wallsVersion++; };
document.querySelectorAll('#dock button[data-tool]').forEach(b=>b.onclick=()=>setTool(b.dataset.tool));
document.querySelectorAll('[data-ev]').forEach(b=>b.onclick=()=>{ triggerEvent(b.dataset.ev); updateUI(); });
function bindRange(id, fn, fmt){ const el=$(id), v=$(id+'v'); const upd=()=>{ const x=+el.value; fn(x); v.textContent=fmt(x); }; el.oninput=upd; upd(); }
bindRange('speed', x=>speed=x, x=>x+'x');
bindRange('brush', x=>brush=x, x=>x);
bindRange('food', x=>CFG.food=x/100, x=>(x/100).toFixed(2));
bindRange('mut', x=>CFG.mut=x/100, x=>(x/100).toFixed(2));
bindRange('maxpop', x=>CFG.maxPop=x, x=>x);
$('sexual').onchange = e=>CFG.sexual=e.target.checked;
$('respawn').onchange = e=>CFG.respawn=e.target.checked;
$('bloomCk').checked = OPT.bloom; $('weatherCk').checked = OPT.weather;
$('bloomCk').onchange = e=>{ OPT.bloom=e.target.checked; store.set('bloom', OPT.bloom); };
$('weatherCk').onchange = e=>{ OPT.weather=e.target.checked; store.set('weather', OPT.weather); };
$('dayCk').onchange = e=>{ CFG.dayNight=e.target.checked; };
$('showVision').onchange = e=>OPT.vision=e.target.checked;
$('showMini').onchange = e=>{ OPT.mini=e.target.checked; $('minimap').style.opacity = OPT.mini?1:0; $('minimap').style.pointerEvents = OPT.mini?'auto':'none'; };
$('btnFollow').onclick = ()=>{ if(selected){ following=!following; updateFollowBtn(); } };
$('btnDesel').onclick = ()=>select(null);
$('btnFeed').onclick = ()=>{ if(selected){ selected.energy = selected.maxE; selected.hp=selected.maxHp; for(let i=0;i<10;i++){ const a=Math.random()*6.283; emit(0,selected.x,selected.y,Math.cos(a),Math.sin(a),30,2.5,1,0.85,0.3,1,1,{drag:0.93}); } updateInspector(); } };
$('btnKill').onclick = ()=>{ if(selected){ kill(selected,'smitten'); S.creatures=S.creatures.filter(c=>!c.dead); updateInspector(); } };
$('btnClone').onclick = ()=>{ if(selected){ const c=selected; const k=new Creature(mutateGenes(c.g,CFG.mut), mutateBrain(c.w,CFG.mut), c.x+10, c.y+10, c.gen+1, c.lineage); k.energy=k.maxE*0.8; if(isWall(k.x,k.y)){k.x=c.x;k.y=c.y;} S.creatures.push(k); S.births++; c.children++; fx('birth',k.x,k.y,k); } };
$('panel').addEventListener('click', e=>{ const id = e.target.dataset && e.target.dataset.sel; if (id){ const c = S.creatures.find(c=>c.id==id); if (c){ select(c); following=true; updateFollowBtn(); camT.z=Math.max(camT.z,1.4); } } });

/* ---------- main loop ---------- */
let frame = 0, tpsCount = 0, tpsT = performance.now(), fpsCount = 0, lastT = performance.now(), simMs = 0, renderMs = 0;
const startT = performance.now();
function buildView(now, dt){
  const k = 1 - Math.exp(-dt*0.05);
  const light = atmosphere(Math.min(1, k*1.5));
  if (following && selected && !selected.dead){ camT.x = selected.x; camT.y = selected.y; }
  const e = 1 - Math.exp(-dt*0.14);
  cam.z = Math.exp(Math.log(cam.z) + (Math.log(camT.z)-Math.log(cam.z))*e);
  cam.x += (camT.x-cam.x)*e; cam.y += (camT.y-cam.y)*e;
  if (!isFinite(cam.x)) Object.assign(cam, camT);
  for (const c of [cam, camT]){
    const hw = vw/2/c.z, hh = vh/2/c.z, m = 60;
    c.x = (2*hw > W+2*m) ? W/2 : clamp(c.x, hw-m, W-hw+m);
    c.y = (2*hh > H+2*m) ? H/2 : clamp(c.y, hh-m, H-hh+m);
  }
  const sh = VFX.shake; const vc = {x:cam.x + (Math.random()-0.5)*sh/cam.z, y:cam.y + (Math.random()-0.5)*sh/cam.z, z:cam.z};
  const view = {x0: vc.x - vw/2/vc.z, x1: vc.x + vw/2/vc.z, y0: vc.y - vh/2/vc.z, y1: vc.y + vh/2/vc.z};
  const E = S.env;
  return { cam:vc, vw, vh, dpr, time:(now-startT)/1000, light, view, seasonF: ((VS.seasonF%4)+4)%4,
    drought:VS.drought, frost:VS.frost, wet:VS.wet, heat:VS.heat, grade:VS.grade,
    glow: OPT.bloom ? 0.3 + (1-E.daylight)*0.5 : 0.18 + (1-E.daylight)*0.3, bloom: OPT.bloom,
    plantCol: VS.plant, flowerCol: E.event==='bloom' ? [1,0.62,0.9] : [1,0.85,0.55], flowering: E.event==='bloom' || E.season===0 };
}
function renderFrame(now, dt){
  const V = buildView(now, dt);
  if (OPT.weather) weather(V.view, dt); else { for (const g of VFX.ghosts) g.t+=dt; VFX.ghosts = VFX.ghosts.filter(g=>g.t<g.max); VFX.shake*=0.88; VFX.flash*=0.9; }
  consumeSimFx(400);
  updateParticles(dt);
  const r0 = performance.now();
  if (useGL) { if (!GLR.render(V)) { switchTo2D(); render2D(V); } }
  else render2D(V);
  drawOverlay(V, now);
  renderMs = renderMs*0.9 + (performance.now()-r0)*0.1;
}
function loop(now){
  const dt = clamp((now - lastT)/16.667, 0.25, 4); lastT = now;
  if (running){
    const t0 = performance.now();
    for (let i=0;i<speed;i++){ tick(); tpsCount++; if (performance.now()-t0 > 35) break; }
    simMs = simMs*0.9 + (performance.now()-t0)*0.1;
  } else if (S.fx.length > 400) S.fx.splice(0, S.fx.length-400);
  renderFrame(now, dt);
  fpsCount++;
  if (++frame % 10 === 0) updateUI();
  if (frame % 6 === 0) drawMini();
  if (now - tpsT > 1000){ $('tpsv').textContent = Math.round(tpsCount*1000/(now-tpsT)); const fps = fpsCount*1000/(now-tpsT); $('fpsv').textContent = Math.round(fps);
    // adaptive resolution: keep the GPU path smooth on weak devices
    if (useGL && !FIXEDRES && document.visibilityState==='visible'){
      if (fps < 38){ if (++lowFps >= 2 && glScale > 0.5){ glScale = Math.max(0.5, glScale*0.8); resize(); lowFps = 0; } } else lowFps = 0;
      if (fps > 57 && glScale < 1){ if (++highFps >= 4){ glScale = Math.min(1, glScale*1.15); resize(); highFps = 0; } } else highFps = 0;
    } tpsCount=0; fpsCount=0; tpsT=now; }
  requestAnimationFrame(loop);
}
function switchTo2D(){ useGL=false; glCanvas.style.display='none'; c2d.style.display='block'; ctx2d = c2d.getContext('2d'); $('fallbackNote').style.display='block'; $('bloomCk').disabled=true; }
window.addEventListener('resize', ()=>{ resize(); });

/* ---------- PWA (only when served over http/https; file:// and sandboxed iframes skip this) ---------- */
function setupPWA(){
  try {
    if (!/^https?:$/.test(location.protocol) || window.LW_SINGLE_FILE) return;
    const link = document.createElement('link'); link.rel='manifest'; link.href='manifest.webmanifest'; document.head.appendChild(link);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
  } catch(e){}
}

window.LW = {
  get state(){ return S; }, tick, reset, spawnCreature, CFG, OPT, triggerEvent, select, setRunning, fitView, updateUI,
  runTicks(n){ for (let i=0;i<n;i++){ tick(); if (S.fx.length>2000) S.fx.splice(0, S.fx.length-300); } },
  renderOnce(dtFrames){ const now=performance.now(); renderFrame(now, dtFrames||1); },
  zoomTo(c,z){ select(c); following=true; updateFollowBtn(); camT.x=cam.x=c.x; camT.y=cam.y=c.y; camT.z=cam.z=z||1; },
  setCam(x,y,z){ following=false; camT.x=cam.x=x; camT.y=cam.y=y; camT.z=cam.z=z; },
  lastScorch(){ return VFX.scorch[VFX.scorch.length-1]; },
  get renderer(){ return useGL?'webgl2':'canvas2d'; },
  timings(){ return {simMs, renderMs, glScale}; },
  setPanel, setTool,
  counts(){ let h=0,p=0; for (const c of S.creatures){ if(c.pred)p++; else h++; } return {t:S.t,h,p,plants:S.plants.length,maxGen:S.maxGen,species:S.species,event:S.env.event,rescues:S.extinctions}; }
};

/* ---------- boot ---------- */
(function boot(){
  let params; try { params = new URLSearchParams(location.search); } catch(e){ params = new URLSearchParams(''); }
  const seed0 = params.get('seed') || 'gaia';
  $('seed').value = seed0;
  resize();
  useGL = params.get('renderer') !== '2d' && GLR.init(glCanvas);
  if (!useGL) switchTo2D();
  reset(seed0);
  if (vw < 820) setPanel(true);
  fitView(true);
  updateUI();
  if (params.get('paused')) setRunning(false);
  setupPWA();
  requestAnimationFrame(t=>{ lastT=t; loop(t); });
})();
