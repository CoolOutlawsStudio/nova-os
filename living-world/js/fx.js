/* Particle system + visual-only effects (weather, ghosts, shake). Renderer agnostic. */
'use strict';
const PMAX = 9000;
const P = {
  n:0, x:new Float32Array(PMAX), y:new Float32Array(PMAX), vx:new Float32Array(PMAX), vy:new Float32Array(PMAX),
  life:new Float32Array(PMAX), max:new Float32Array(PMAX), size:new Float32Array(PMAX), grow:new Float32Array(PMAX),
  r:new Float32Array(PMAX), g:new Float32Array(PMAX), b:new Float32Array(PMAX), a:new Float32Array(PMAX),
  type:new Uint8Array(PMAX), add:new Uint8Array(PMAX), rot:new Float32Array(PMAX), vr:new Float32Array(PMAX),
  drag:new Float32Array(PMAX), grav:new Float32Array(PMAX)
};
// types: 0 glow, 1 ring, 2 leaf, 3 rain streak, 4 snow, 5 smoke, 6 spark streak, 7 firefly
const VFX = { ghosts:[], shake:0, flash:0, flashCol:[1,0.8,0.6], scorch:[] };
function emit(type,x,y,vx,vy,life,size,r,g,b,a,add,opt){
  let i = P.n;
  if (i >= PMAX) { i = (Math.random()*PMAX)|0; } else P.n++;
  P.type[i]=type; P.x[i]=x; P.y[i]=y; P.vx[i]=vx; P.vy[i]=vy; P.life[i]=0; P.max[i]=life; P.size[i]=size;
  P.r[i]=r; P.g[i]=g; P.b[i]=b; P.a[i]=a; P.add[i]=add?1:0;
  P.rot[i]= opt&&opt.rot!==undefined?opt.rot:Math.random()*6.283; P.vr[i]=opt&&opt.vr||0; P.drag[i]=opt&&opt.drag!==undefined?opt.drag:0.96;
  P.grow[i]=opt&&opt.grow||0; P.grav[i]=opt&&opt.grav||0;
}
const splashes = [];
function updateParticles(dt){
  splashes.length = 0;
  let n = P.n;
  for (let i=0;i<n;i++){
    P.life[i] += dt;
    if (P.life[i] >= P.max[i]){
      // rain hits the ground → tiny splash ring
      if (P.type[i]===3 && Math.random()<0.5) splashes.push(P.x[i], P.y[i]);
      n--; copyP(n,i); i--; continue;
    }
    const d = Math.pow(P.drag[i], dt);
    P.vx[i]*=d; P.vy[i]=P.vy[i]*d + P.grav[i]*dt;
    P.x[i]+=P.vx[i]*dt; P.y[i]+=P.vy[i]*dt; P.rot[i]+=P.vr[i]*dt; P.size[i]+=P.grow[i]*dt;
    if (P.type[i]===4){ P.vx[i] += Math.sin(P.life[i]*0.08 + i)*0.02*dt; }
    if (P.type[i]===7){ P.vx[i] += (Math.random()-0.5)*0.08*dt; P.vy[i] += (Math.random()-0.5)*0.08*dt; }
  }
  P.n = n;
  for (let i=0;i<splashes.length;i+=2) emit(1,splashes[i],splashes[i+1],0,0,14,2.5,0.75,0.85,1,0.35,1,{grow:0.35});
}
function copyP(from,to){ for (const k in P){ if (k!=='n') P[k][to]=P[k][from]; } }

function onWorldReset(){ P.n = 0; VFX.ghosts.length = 0; VFX.scorch.length = 0; }

function consumeSimFx(maxPerFrame){
  const q = S.fx; const n = q.length; const keep = n > maxPerFrame ? maxPerFrame/n : 1;
  for (let k=0; k<n; k++){
    const e = q[k];
    if (keep < 1 && e.type !== 'meteor' && e.type !== 'death' && Math.random() > keep) continue;
    if (e.type==='birth'){
      const c=e.a, [r,g,b]=c.rgb;
      for (let i=0;i<9;i++){ const a=Math.random()*6.283, s=0.4+Math.random()*1.4; emit(0,e.x,e.y,Math.cos(a)*s,Math.sin(a)*s,30+Math.random()*25,1.6+Math.random()*2.2, i%3?r*0.6+0.4:1, i%3?g*0.6+0.4:0.95, i%3?b*0.6+0.4:0.7, 0.9, 1, {drag:0.93}); }
      emit(1,e.x,e.y,0,0,26,c.r*0.8,r,g,b,0.6,1,{grow:0.7});
    } else if (e.type==='eat'){
      const c=e.a; const pc = plantRGB();
      for (let i=0;i<3;i++){ const a=Math.random()*6.283, s=0.3+Math.random()*0.8; emit(2,e.x,e.y,Math.cos(a)*s,Math.sin(a)*s,28+Math.random()*20,1.8+Math.random()*1.4, pc[0],pc[1],pc[2],0.9,0,{vr:(Math.random()-0.5)*0.3,drag:0.92}); }
    } else if (e.type==='death'){
      const c=e.a, [r,g,b]=c.rgb;
      VFX.ghosts.push({c, t:0, max: e.b==='eaten'?22:55, x:c.x, y:c.y});
      if (VFX.ghosts.length>200) VFX.ghosts.shift();
      if (e.b==='eaten'){
        for (let i=0;i<12;i++){ const a=Math.random()*6.283, s=0.6+Math.random()*2.2; emit(6,e.x,e.y,Math.cos(a)*s,Math.sin(a)*s,18+Math.random()*16,1.4+Math.random()*1.4,1,0.25+Math.random()*0.2,0.2,0.95,1,{drag:0.9}); }
        emit(1,e.x,e.y,0,0,20,c.r,1,0.35,0.3,0.7,1,{grow:1.0});
      } else if (e.b==='smitten'){
        for (let i=0;i<14;i++){ const a=Math.random()*6.283, s=0.8+Math.random()*2.5; emit(6,e.x,e.y,Math.cos(a)*s,Math.sin(a)*s,22,1.6,0.75,0.65,1,1,1,{drag:0.9}); }
        emit(1,e.x,e.y,0,0,24,c.r,0.8,0.7,1,0.9,1,{grow:1.6});
        VFX.flash = Math.max(VFX.flash, 0.12); VFX.flashCol=[0.7,0.6,1];
      } else {
        for (let i=0;i<5;i++){ const a=Math.random()*6.283, s=0.15+Math.random()*0.4; emit(5,e.x,e.y,Math.cos(a)*s,Math.sin(a)*s,60+Math.random()*40,c.r*0.8,0.55,0.55,0.6,0.35,0,{grow:0.12,drag:0.97}); }
      }
    } else if (e.type==='meteor'){
      const R = e.a;
      VFX.shake = 26; VFX.flash = 0.85; VFX.flashCol=[1,0.75,0.5];
      VFX.scorch.push({x:e.x,y:e.y,r:R*0.9,t:0});
      emit(1,e.x,e.y,0,0,50,10,1,0.75,0.45,1,1,{grow:R*0.07});
      emit(1,e.x,e.y,0,0,70,10,1,0.5,0.25,0.6,1,{grow:R*0.045});
      emit(0,e.x,e.y,0,0,40,R*0.9,1,0.7,0.35,1,1,{grow:-R*0.015});
      for (let i=0;i<180;i++){ const a=Math.random()*6.283, s=1+Math.random()*7; emit(6,e.x,e.y,Math.cos(a)*s,Math.sin(a)*s,30+Math.random()*50,2+Math.random()*2.5,1,0.45+Math.random()*0.4,0.15,1,1,{drag:0.94}); }
      for (let i=0;i<50;i++){ const a=Math.random()*6.283, s=0.3+Math.random()*2.2; emit(5,e.x+Math.cos(a)*R*0.3*Math.random(),e.y+Math.sin(a)*R*0.3*Math.random(),Math.cos(a)*s,Math.sin(a)*s,120+Math.random()*120,10+Math.random()*16,0.22,0.2,0.2,0.55,0,{grow:0.15,drag:0.97}); }
    }
  }
  q.length = 0;
}
let _plantRGB=[0.4,0.8,0.4];
function plantRGB(){ return _plantRGB; }

// weather + ambience; view = {x0,y0,x1,y1}
function weather(view, dt){
  const E = S.env; const ev = E.event;
  const area = Math.max(1,(view.x1-view.x0)*(view.y1-view.y0));
  const dens = area/ (1600*950);
  const rainy = ev==='bloom' || (E.season===0 && (Math.floor(S.t/DAY)%3===1));
  const snowy = ev==='coldsnap' || E.season===3;
  const hot = ev==='heatwave' || ev==='drought';
  const X0=Math.max(0,view.x0), X1=Math.min(W,view.x1), Y0=Math.max(0,view.y0), Y1=Math.min(H,view.y1);
  if (X1<=X0+1 || Y1<=Y0+1) { VFX.shake *= 0.9; }
  const rx = ()=>X0 + Math.random()*(X1-X0), ry = ()=>Y0 - 30 + Math.random()*(Y1-Y0);
  if (rainy){ const n = Math.min(40, (ev==='bloom'?26:10)*dens*dt+Math.random()); for (let i=0;i<n;i++) emit(3,rx(),ry(),1.8,10,16+Math.random()*16,1,0.75,0.85,1,0.75,1,{rot:Math.atan2(10,1.8)-Math.PI/2,drag:1}); }
  if (snowy){ const n = Math.min(30, (ev==='coldsnap'?10:4)*dens*dt+Math.random()); for (let i=0;i<n;i++) emit(4,rx(),ry(),0.3+Math.random()*0.5,0.9+Math.random()*0.8,140+Math.random()*120,1.4+Math.random()*1.8,1,1,1,0.85,1,{drag:1,vr:0.02}); }
  if (hot && Math.random()<0.5*dt){ emit(5,rx(),view.y0+Math.random()*(view.y1-view.y0),0,-0.35,90,8+Math.random()*10,1,0.75,0.45,0.08,1,{grow:0.15,drag:1}); }
  // fireflies on warm nights near fertile ground
  if (E.daylight < 0.35 && (E.season===0 || E.season===1) && !snowy && Math.random() < 0.8*dt*Math.min(2,dens)){
    const h = S.hotspots[(Math.random()*S.hotspots.length)|0];
    emit(7, h.x+(Math.random()-0.5)*h.r*2, h.y+(Math.random()-0.5)*h.r*2, 0,0, 150+Math.random()*150, 1.6+Math.random(), 0.85,1,0.45,0.9,1,{drag:0.95});
  }
  for (const g of VFX.ghosts) g.t += dt;
  VFX.ghosts = VFX.ghosts.filter(g=>g.t<g.max);
  for (const s of VFX.scorch) s.t += dt;
  VFX.scorch = VFX.scorch.filter(s=>s.t<2400);
  VFX.shake *= Math.pow(0.88, dt); VFX.flash *= Math.pow(0.9, dt);
}
