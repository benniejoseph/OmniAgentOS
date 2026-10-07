// Original ATLAS Scout vector rig. Run from any directory to author both deliveries.
// Geometry, poses and keyframes are original. LottieFiles references inform gestures only.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const web = resolve(root, 'public/companion/atlas-lottie');
const native = resolve(root, 'apps/flutter/assets/companion/atlas-lottie');
const states = ['available','listening','working','responding','needs_you','blocked','completed','paused'];
const revision = 'atlas-scout-20261007';
const palettes = {
  light: { shell:'#FAF9F6', edge:'#DDD8D0', outline:'#827A70', face:'#242321', light:'#FAF9F6', gold:'#806019', shadow:'#242321', success:'#286243', warning:'#805814' },
  dark: { shell:'#F4F1EA', edge:'#D9D4CB', outline:'#888980', face:'#191A1B', light:'#FAF9F6', gold:'#E2BD74', shadow:'#000000', success:'#91CFAC', warning:'#E7C37C' },
};
const fixed = (k) => ({a:0,k});
const color = (hex) => [...[1,3,5].map((n)=>parseInt(hex.slice(n,n+2),16)/255),1];
const vector = (value) => Array.isArray(value) ? value : [value];
const keys = (values) => ({a:1,k:values.map(([t,value],index)=>({t,s:vector(value),...(index<values.length-1?{e:vector(values[index+1][1]),i:{x:[.25],y:[1]},o:{x:[.25],y:[0]}}:{})}))});
const path = (v,c=false,i=v.map(()=>[0,0]),o=v.map(()=>[0,0])) => ({v,i,o,c});
function roundedRect(x,y,w,h,r) {
  const l=x-w/2, t=y-h/2, right=x+w/2, b=y+h/2, k=.55228475*r;
  return path([[l+r,t],[right-r,t],[right,t+r],[right,b-r],[right-r,b],[l+r,b],[l,b-r],[l,t+r]],true,
    [[-k,0],[0,0],[0,-k],[0,0],[k,0],[0,0],[0,k],[0,0]],
    [[0,0],[k,0],[0,0],[0,k],[0,0],[-k,0],[0,0],[0,-k]]);
}
const ellipse = (x,y,w,h) => ({ellipse:[w,h],position:[x,y]});
const outline = (points,c=false,i,o) => ({path:path(points,c,i,o)});
const rect = (x,y,w,h,r) => ({path:roundedRect(x,y,w,h,r)});
const shape = (name,geometry,fill,stroke=null,width=1,opacity=100) => ({name,geometry,fill,stroke,width,opacity});
const smile = outline([[-11,15],[0,21],[11,15]],false,[[0,0],[-5,0],[-2,4]],[[2,4],[5,0],[0,0]]);
const flatMouth = outline([[-8,19],[8,19]]);
const headShell = outline([[-79,-5],[-61,-47],[3,-58],[62,-44],[80,-4],[74,32],[48,54],[-51,51],[-77,27]],true,
  [[0,-18],[-14,10],[-24,-1],[-17,-12],[-1,-18],[5,-9],[19,-1],[22,6],[7,13]],
  [[0,14],[14,-10],[24,1],[12,9],[1,17],[-8,16],[-24,2],[-19,-6],[-6,-11]]);
const crest = outline([[-28,-48],[-24,-70],[-11,-65],[4,-66],[0,-50]],true,
  [[-1,5],[-6,-2],[-6,-3],[-5,-2],[2,-6]],[[1,-7],[5,1],[6,2],[-1,6],[-7,0]]);

function pose(state) {
  return {
    head: state==='listening' ? -7 : state==='blocked' ? 5 : state==='needs_you' ? -3 : 0,
    left: state==='completed' ? 133 : state==='responding' ? 43 : 14,
    right: state==='listening' ? -145 : state==='needs_you' ? -138 : state==='completed' ? -133 : state==='responding' ? -47 : -14,
    look: state==='working' ? [3,6] : state==='listening' ? [-4,0] : state==='needs_you' ? [0,-2] : [0,0],
    eyes: state==='paused' ? 48 : 100,
  };
}
function rig(state,theme) {
  const p=palettes[theme], rest=pose(state), frames=36, end=frames-1;
  const rows=[];
  const add=(name,items,position=[0,0],extra={})=>{
    const row={name,items,position,rotation:0,scale:[100,100,100],...extra};
    row.id=rows.length+1;rows.push(row);return row.id;
  };
  // Every child uses parent transforms. A face turn carries its eyes, crest and
  // mouth together; hands articulate at the shoulder instead of sliding apart.
  add('Ground shadow',[shape('Soft footprint',ellipse(0,0,96,13),p.shadow,null,0,10)],[128,231]);
  const body=add('Scout root',[],[128,132]);
  add('Left boot',[shape('Boot',rect(0,0,28,15,7),p.gold)],[-22,84],{parent:body});
  add('Right boot',[shape('Boot',rect(0,0,28,15,7),p.gold)],[22,84],{parent:body});
  const arm=(side,angle)=>add(`${side} hand`,[
    shape('Sleeve',rect(0,16,21,42,10),p.edge,p.outline,1.8),
    shape('Palm',ellipse(0,35,26,23),p.shell,p.outline,1.8),
    shape('Cuff',rect(0,26,20,6,3),p.gold),
  ],[side==='Left'?-52:52,26],{parent:body,rotation:angle});
  const left=arm('Left',rest.left),right=arm('Right',rest.right);
  add('Body',[shape('Body shell',rect(0,0,75,67,28),p.shell,p.outline,2),shape('Lower contour',outline([[-23,19],[0,25],[23,19]],false,[[0,0],[-10,0],[-4,4]],[[4,4],[10,0],[0,0]]),null,p.edge,3)],[0,53],{parent:body});
  add('Collar',[shape('Soft collar',rect(0,0,59,15,7),p.face)],[0,18],{parent:body});
  const head=add('Head',[
    shape('Gold crest',crest,p.gold),
    shape('Helmet shell',headShell,p.shell,p.outline,2),
    shape('Lower shell contour',outline([[-59,34],[-20,44],[33,42],[58,31]],false,[[0,0],[-14,-1],[-17,3],[-7,7]],[[8,7],[17,2],[14,-3],[0,0]]),null,p.edge,4),
    shape('Dark face',rect(0,2,129,76,29),p.face),
    shape('Brow highlight',outline([[-46,-37],[-11,-45],[25,-41]],false,[[0,0],[-11,-1],[-12,-4]],[[10,-6],[11,1],[0,0]]),null,'#FFFFFF',3,70),
  ],[0,-39],{parent:body,rotation:rest.head});
  const [lookX,lookY]=rest.look;
  const eye=(side)=>add(`${side} eye`,[shape('Eye',rect(0,0,14,23,7),p.light)],[lookX+(side==='Left'?-26:26),lookY-2],{parent:head,scale:[100,rest.eyes,100]});
  const leftEye=eye('Left'),rightEye=eye('Right');
  const mouth=add('Expression',[
    shape('Mouth',state==='paused'||state==='blocked'?flatMouth:state==='responding'?ellipse(0,19,15,11):smile,state==='responding'?p.light:null,state==='responding'?null:p.light,3.5),
  ],[lookX,lookY],{parent:head});
  const badgeItems=state==='completed' ? [shape('Confirmed check',outline([[-8,0],[-2,6],[9,-7]]),null,p.success,4)]
    : state==='paused' ? [shape('Pause left',rect(-4,0,3.5,14,1.7),p.gold),shape('Pause right',rect(4,0,3.5,14,1.7),p.gold)]
    : state==='blocked'||state==='needs_you' ? [shape('Attention stem',rect(0,-3,4,12,2),p.warning),shape('Attention point',ellipse(0,8,4,4),p.warning)]
    : [shape('Scout badge',rect(0,0,14,14,5),p.gold),shape('Badge light',rect(0,-1,4,6,2),p.shell)];
  const badge=add('Chest badge',badgeItems,[0,52],{parent:body});
  if(state==='listening') add('Listening mark',[shape('Listening arc',outline([[0,-11],[5,0],[0,11]],false,[[0,0],[0,-5],[3,-3]],[[3,3],[0,5],[0,0]]),null,p.gold,3)],[29,92]);
  if(state==='completed') {
    add('Left acknowledgment',[shape('Glint',outline([[0,-7],[0,7]]),null,p.gold,2.5),shape('Glint cross',outline([[-7,0],[7,0]]),null,p.gold,2.5)],[38,66],{opacityFrames:[[0,0],[8,100],[23,100],[end,0]]});
    add('Right acknowledgment',[shape('Glint',outline([[0,-5],[0,5]]),null,p.gold,2),shape('Glint cross',outline([[-5,0],[5,0]]),null,p.gold,2)],[217,79],{opacityFrames:[[0,0],[11,100],[25,100],[end,0]]});
  }
  const at=(id)=>rows[id-1];
  const turn=(id,values)=>at(id).rotationFrames=values;
  const move=(id,values)=>at(id).positionFrames=values;
  const scale=(id,values)=>at(id).scaleFrames=values;
  const blink=(id,start=23)=>scale(id,[[0,[100,rest.eyes,100]],[start,[100,rest.eyes,100]],[start+2,[100,8,100]],[start+4,[100,rest.eyes,100]],[end,[100,rest.eyes,100]]]);
  blink(leftEye);blink(rightEye);
  if(state==='available') {
    turn(right,[[0,-14],[8,-141],[13,-119],[18,-145],[23,-121],[end,-14]]);
    turn(head,[[0,0],[8,-4],[23,-4],[end,0]]);
  } else if(state==='listening') {
    turn(head,[[0,0],[10,-9],[24,-9],[end,rest.head]]);
    turn(right,[[0,-20],[11,-151],[25,-151],[end,rest.right]]);
  } else if(state==='working') {
    turn(head,[[0,0],[8,5],[19,-3],[28,2],[end,0]]);
    move(leftEye,[[0,[-26,-2]],[8,[-23,4]],[20,[-29,4]],[end,[-23,4]]]);
    move(rightEye,[[0,[26,-2]],[8,[29,4]],[20,[23,4]],[end,[29,4]]]);
    turn(left,[[0,14],[8,-25],[16,-15],[24,-25],[end,14]]);
    turn(right,[[0,-14],[8,25],[16,15],[24,25],[end,-14]]);
  } else if(state==='responding') {
    turn(left,[[0,14],[9,47],[23,38],[end,rest.left]]);
    turn(right,[[0,-14],[9,-51],[23,-39],[end,rest.right]]);
    scale(mouth,[[0,[100,65,100]],[6,[100,115,100]],[11,[100,70,100]],[16,[100,120,100]],[23,[100,65,100]],[29,[100,105,100]],[end,[100,100,100]]]);
  } else if(state==='needs_you') {
    turn(right,[[0,-14],[10,-148],[18,-127],[25,-142],[end,rest.right]]);
    turn(head,[[0,0],[12,-6],[end,rest.head]]);
  } else if(state==='blocked') {
    turn(head,[[0,0],[9,7],[end,rest.head]]);
    scale(leftEye,[[0,[100,100,100]],[12,[100,76,100]],[end,[100,76,100]]]);
    at(leftEye).scale=[100,76,100];
  } else if(state==='completed') {
    turn(left,[[0,14],[11,139],[22,139],[end,rest.left]]);
    turn(right,[[0,-14],[11,-139],[22,-139],[end,rest.right]]);
    move(body,[[0,[128,132]],[10,[128,126]],[21,[128,126]],[end,[128,132]]]);
    scale(badge,[[0,[65,65,100]],[12,[100,100,100]],[end,[100,100,100]]]);
  }
  // All scenes end in the exact SVG pose; no ambient loop or hidden idle ticker.
  return {rows,frames};
}
function group(row) {
  const g=row.geometry;
  const items=[g.ellipse?{ty:'el',d:1,s:fixed(g.ellipse),p:fixed(g.position),nm:row.name}:{ty:'sh',ks:fixed(g.path),nm:row.name}];
  if(row.stroke)items.push({ty:'st',c:fixed(color(row.stroke)),o:fixed(row.opacity),w:fixed(row.width),lc:2,lj:2,ml:4,nm:'Stroke'});
  if(row.fill)items.push({ty:'fl',c:fixed(color(row.fill)),o:fixed(row.opacity),r:1,nm:'Fill'});
  items.push({ty:'tr',p:fixed([0,0]),a:fixed([0,0]),s:fixed([100,100]),r:fixed(0),o:fixed(100),sk:fixed(0),sa:fixed(0)});
  return {ty:'gr',it:items,nm:row.name};
}
function layer(row,frames) {
  const position=row.position.map((n)=>n);position.push(0);
  return {ddd:0,ind:row.id,ty:4,nm:row.name,sr:1,...(row.parent?{parent:row.parent}:{}),ks:{
    o:row.opacityFrames?keys(row.opacityFrames):fixed(100),
    r:row.rotationFrames?keys(row.rotationFrames):fixed(row.rotation),
    p:row.positionFrames?keys(row.positionFrames.map(([t,v])=>[t,[...v,0]])):fixed(position),
    a:fixed([0,0,0]),s:row.scaleFrames?keys(row.scaleFrames):fixed(row.scale),
  },ao:0,shapes:[...row.items].reverse().map(group),ip:0,op:frames,st:0,bm:0};
}
function svgPath(p) {
  let d=`M ${p.v[0].join(' ')}`;
  for(let n=0;n<(p.c?p.v.length:p.v.length-1);n++){
    const next=(n+1)%p.v.length,a=p.v[n],b=p.v[next];
    d+=` C ${a[0]+p.o[n][0]} ${a[1]+p.o[n][1]} ${b[0]+p.i[next][0]} ${b[1]+p.i[next][1]} ${b.join(' ')}`;
  }
  return d+(p.c?' Z':'');
}
function itemSvg(row){
  const g=row.geometry,attrs=`fill="${row.fill??'none'}" stroke="${row.stroke??'none'}" stroke-width="${row.width}" stroke-linecap="round" stroke-linejoin="round" opacity="${row.opacity/100}"`;
  return g.ellipse?`<ellipse cx="${g.position[0]}" cy="${g.position[1]}" rx="${g.ellipse[0]/2}" ry="${g.ellipse[1]/2}" ${attrs}/>`:`<path d="${svgPath(g.path)}" ${attrs}/>`;
}
function poster(rows){
  const transform=(row)=>`translate(${row.position.join(' ')}) rotate(${row.rotation}) scale(${row.scale[0]/100} ${row.scale[1]/100})`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="none">${rows.map(row=>{
    if(row.opacityFrames?.at(-1)?.[1]===0)return '';
    const ancestors=[];let parent=row.parent;while(parent){const found=rows[parent-1];ancestors.unshift(found);parent=found.parent;}
    return [...ancestors,row].map(r=>`<g transform="${transform(r)}">`).join('')+row.items.map(itemSvg).join('')+'</g>'.repeat(ancestors.length+1);
  }).join('')}</svg>\n`;
}
await Promise.all([mkdir(web,{recursive:true}),mkdir(native,{recursive:true})]);
for(const theme of Object.keys(palettes))for(const state of states){
  const {rows,frames}=rig(state,theme);
  const data={v:'5.12.2',fr:30,ip:0,op:frames,w:256,h:256,nm:`ATLAS Scout · ${state} · ${theme}`,ddd:0,assets:[],layers:[...rows].reverse().map(row=>layer(row,frames)),markers:[{tm:0,cm:state,dr:frames}]};
  const json=`${JSON.stringify(data)}\n`;
  await Promise.all([writeFile(resolve(web,`${state}-${theme}.json`),json),writeFile(resolve(native,`${state}-${theme}.json`),json),writeFile(resolve(web,`${state}-${theme}.svg`),poster(rows))]);
}
await writeFile(resolve(web,'provenance.json'),`${JSON.stringify({creativeRevision:revision,creator:'Original Asael ATLAS Scout vector rig',source:'.design/asael-ace-revamp/atlas-lottie/source/generate.mjs',format:'Lottie JSON; vector shape layers, parented character rig',frameRate:30,externalAssets:false,paletteSource:'src/app/globals.css and apps/flutter/lib/app/theme/app_theme.dart',states,references:[{title:'Robot standing',creator:'Penxel Studio',url:'https://lottiefiles.com/free-animation/robot-standing-cdB6OGVdsa',influence:'Readable face and restrained blink'},{title:'Cute Bot Say Users Hello',creator:'Abdul Latif',url:'https://lottiefiles.com/free-animation/cute-bot-say-users-hello-fsKwsuIXi0',influence:'Clear greeting silhouette and friendly proportions'},{title:'Futuristic Robot Constructor',creator:'Tanjil Mahmud',url:'https://lottiefiles.com/free-animation/futuristic-robot-constructor-5FSNfVhxoG',influence:'Articulated hand gesture'}],thirdPartyArtworkEmbedded:false},null,2)}\n`);
