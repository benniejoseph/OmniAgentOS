// Original ATLAS Scout vector rig. Run from any directory to author both deliveries.
// Geometry, poses and keyframes are self-authored. No remote artwork is embedded.
// Voice-presence revision: the approved 9 October study, adapted to finite clips.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const web = resolve(root, 'public/companion/atlas-lottie');
const native = resolve(root, 'apps/flutter/assets/companion/atlas-lottie');
const states = ['available','listening','working','responding','needs_you','blocked','completed','paused'];
const revision = 'atlas-scout-20261009-voice';
const palettes = {
  light: { shell:'#FAF9F6', edge:'#DDD8D0', rim:'#BDB6A9', outline:'#827A70', face:'#242321', faceEdge:'#4D4D46', light:'#FAF9F6', gold:'#806019', shadow:'#242321', success:'#286243', warning:'#805814' },
  dark: { shell:'#F4F1EA', edge:'#D9D4CB', rim:'#B7B0A2', outline:'#888980', face:'#191A1B', faceEdge:'#424640', light:'#FAF9F6', gold:'#E2BD74', shadow:'#000000', success:'#91CFAC', warning:'#E7C37C' },
};
const fixed = (k) => ({a:0,k});
const color = (hex) => [...[1,3,5].map((n)=>parseInt(hex.slice(n,n+2),16)/255),1];
const vector = (value) => Array.isArray(value) ? value : [value];
const keys = (values) => ({a:1,k:values.map(([t,value],index)=>({t,s:vector(value),...(index<values.length-1?{e:vector(values[index+1][1]),i:{x:[.22],y:[1]},o:{x:[.3],y:[0]}}:{})}))});
const path = (v,c=false,i=v.map(()=>[0,0]),o=v.map(()=>[0,0])) => ({v,i,o,c});
function roundedRect(x,y,w,h,r) {
  const l=x-w/2,t=y-h/2,right=x+w/2,b=y+h/2,k=.55228475*r;
  return path([[l+r,t],[right-r,t],[right,t+r],[right,b-r],[right-r,b],[l+r,b],[l,b-r],[l,t+r]],true,
    [[-k,0],[0,0],[0,-k],[0,0],[k,0],[0,0],[0,k],[0,0]],
    [[0,0],[k,0],[0,0],[0,k],[0,0],[-k,0],[0,0],[0,-k]]);
}
const ellipse = (x,y,w,h) => ({ellipse:[w,h],position:[x,y]});
const outline = (points,c=false,i,o) => ({path:path(points,c,i,o)});
const rect = (x,y,w,h,r) => ({path:roundedRect(x,y,w,h,r)});
const shape = (name,geometry,fill,stroke=null,width=1,opacity=100) => ({name,geometry,fill,stroke,width,opacity});
const gentleMouth = outline([[-9,-1],[0,2],[9,-1]],false,[[0,0],[-4,0],[-3,2]],[[3,2],[4,0],[0,0]]);
const listeningMouth = outline([[-6,0],[6,0]]);
const headShell = outline([[0,-59],[68,-43],[87,-12],[81,32],[30,57],[-29,57],[-80,31],[-87,-9],[-68,-43]],true,
  [[-28,0],[-16,-14],[0,-13],[5,-10],[20,-2],[20,2],[7,16],[0,19],[-15,12]],
  [[28,0],[17,14],[0,20],[-7,14],[-20,2],[-22,-2],[-5,-13],[0,-16],[15,-12]]);
const crest = outline([[-7,-56],[-3,-68],[1,-72],[19,-72],[12,-66],[5,-66],[1,-56]],true);

function pose(state) {
  return {
    head: state==='listening' ? -8 : state==='working' ? 4 : state==='blocked' ? 4 : state==='needs_you' ? -4 : state==='responding' ? -2 : 0,
    left: state==='completed' ? 112 : state==='responding' ? 48 : state==='working' ? -16 : 12,
    right: state==='listening' ? -151 : state==='needs_you' ? -137 : state==='completed' ? -116 : state==='responding' ? -59 : state==='working' ? 28 : -12,
    look: state==='working' ? [5,-3] : state==='listening' ? [-4,-1] : state==='needs_you' ? [0,-3] : [0,0],
    leftEye: state==='paused' ? 68 : state==='blocked' ? 76 : state==='working' ? 86 : 100,
    rightEye: state==='paused' ? 68 : state==='blocked' ? 90 : state==='listening' ? 108 : 100,
  };
}
function rig(state,theme) {
  const p=palettes[theme],rest=pose(state),frames=36,end=frames-1;
  const rows=[];
  const add=(name,items,position=[0,0],extra={})=>{
    const row={name,items,position,rotation:0,scale:[100,100,100],...extra};
    row.id=rows.length+1;rows.push(row);return row.id;
  };
  add('Ground shadow',[shape('Quiet footprint',ellipse(0,0,113,10),p.shadow,null,0,10)],[128,241]);
  const body=add('Scout root',[],[128,139]);
  for(const [side,x] of [['Left',-23],['Right',23]])add(`${side} foot`,[
    shape('Foot shell',rect(0,0,30,12,6),p.edge,p.outline,1.2),
    shape('Sole seam',outline([[-10,3],[10,3]]),null,p.rim,1.3),
  ],[x,90],{parent:body});
  const arm=(side,angle)=>add(`${side} articulated hand`,[
    shape('Shoulder joint',ellipse(0,3,18,18),p.face),
    shape('Arm shell',rect(0,17,19,31,8),p.edge,p.outline,1.3),
    shape('Arm highlight',outline([[-5,6],[-5,24]]),null,p.shell,2),
    shape('Palm',rect(0,40,23,28,9),p.shell,p.outline,1.3),
    shape('Thumb',ellipse(side==='Left'?-11:11,38,9,14),p.shell,p.outline,1.2),
    shape('Palm cap',rect(0,37,19,17,7),p.shell),
    shape('Finger joint one',outline([[-4,48],[-4,53]]),null,p.rim,1.25),
    shape('Finger joint two',outline([[3,48],[3,53]]),null,p.rim,1.25),
    shape('Fine gold cuff',rect(0,28,19,4,2),p.gold),
  ],[side==='Left'?-60:60,23],{parent:body,rotation:angle});
  const left=arm('Left',rest.left),right=arm('Right',rest.right);
  add('Torso',[
    shape('Torso shell',rect(0,0,85,78,28),p.shell,p.outline,1.5),
    shape('Lower shell contour',outline([[-29,24],[0,31],[29,24]],false,[[0,0],[-12,0],[-5,4]],[[5,4],[12,0],[0,0]]),null,p.edge,3.2),
    shape('Chest inset',rect(0,5,58,49,18),p.face),
    shape('Chest rim',outline([[-20,-11],[0,-16],[20,-11]],false,[[0,0],[-8,0],[-4,-3]],[[4,-3],[8,0],[0,0]]),null,p.faceEdge,1.5),
  ],[0,53],{parent:body});
  add('Collar',[
    shape('Neck',rect(0,-1,38,22,8),p.rim),
    shape('Collar',rect(0,5,55,13,6),p.edge),
    shape('Collar seam',outline([[-18,7],[18,7]]),null,p.outline,1),
  ],[0,17],{parent:body});
  const head=add('Sculpted head',[
    shape('Fine gold crest',crest,p.gold),
    shape('Left temple',rect(-87,3,9,29,4),p.rim),
    shape('Right temple',rect(87,3,9,29,4),p.rim),
    shape('Ivory helmet shell',headShell,p.shell,p.outline,1.5),
    shape('Lower shell bevel',outline([[-68,35],[-29,49],[27,50],[69,34]],false,[[0,0],[-14,-1],[-19,3],[-10,9]],[[9,9],[17,2],[17,-2],[0,0]]),null,p.edge,5),
    shape('Face inset rim',rect(0,4,155,91,29),p.rim),
    shape('Charcoal face',rect(0,5,151,87,27),p.face),
    shape('Visor upper bevel',outline([[-53,-27],[0,-34],[52,-27]],false,[[0,0],[-19,0],[-13,-6]],[[13,-6],[19,0],[0,0]]),null,p.faceEdge,1.35),
    shape('Shell highlight',outline([[-64,-38],[-22,-49],[28,-46]],false,[[0,0],[-15,-1],[-17,-4]],[[12,-8],[17,1],[0,0]]),null,'#FFFFFF',2,60),
  ],[0,-46],{parent:body,rotation:rest.head});
  const [lookX,lookY]=rest.look;
  const eye=(side,height)=>add(`${side} eye`,[
    shape('Eye light',rect(0,0,17,27,8.5),p.light),
    shape('Eye highlight',outline([[-3,-9],[0,-10]]),null,'#FFFFFF',1.1,72),
  ],[lookX+(side==='Left'?-30:30),lookY-1],{parent:head,scale:[100,height,100]});
  const leftEye=eye('Left',rest.leftEye),rightEye=eye('Right',rest.rightEye);
  const lid=(side)=>add(`${side} expressive eyelid`,[
    shape('Upper lid',rect(0,0,22,6,3),p.face),
  ],[lookX+(side==='Left'?-30:30),lookY-16],{parent:head,rotation:state==='blocked'?(side==='Left'?12:-6):state==='working'?(side==='Left'?-8:5):0});
  const leftLid=lid('Left'),rightLid=lid('Right');
  const mouthShape=state==='responding'?ellipse(0,0,13,8):['paused','blocked','listening'].includes(state)?listeningMouth:gentleMouth;
  const mouth=add('Mouth articulation',[
    shape('Mouth',mouthShape,state==='responding'?p.light:null,state==='responding'?null:p.light,2.5),
  ],[lookX,24+lookY],{parent:head});
  const badgeItems=state==='completed' ? [shape('Confirmed check',outline([[-9,0],[-3,6],[10,-8]]),null,p.success,3.6)]
    : state==='paused' ? [shape('Pause left',rect(-4,0,3,12,1.5),p.gold),shape('Pause right',rect(4,0,3,12,1.5),p.gold)]
    : state==='blocked'||state==='needs_you' ? [shape('Attention stem',rect(0,-3,3.5,11,1.75),p.warning),shape('Attention point',ellipse(0,7,3.5,3.5),p.warning)]
    : [shape('Scout insignia',outline([[-8,4],[-2,-6],[3,-6],[9,4]]),null,p.gold,2),shape('Insignia bridge',outline([[-5,0],[5,0]]),null,p.gold,1.6)];
  const badge=add('Chest insignia',badgeItems,[0,57],{parent:body});
  if(state==='completed') {
    add('Left acknowledgment',[shape('Glint',outline([[0,-5],[0,5]]),null,p.gold,2),shape('Glint cross',outline([[-5,0],[5,0]]),null,p.gold,2)],[29,73],{opacityFrames:[[0,0],[8,100],[23,100],[end,0]]});
    add('Right acknowledgment',[shape('Glint',outline([[0,-4],[0,4]]),null,p.gold,1.8),shape('Glint cross',outline([[-4,0],[4,0]]),null,p.gold,1.8)],[227,81],{opacityFrames:[[0,0],[11,100],[25,100],[end,0]]});
  }
  const at=(id)=>rows[id-1];
  const turn=(id,values)=>at(id).rotationFrames=values;
  const move=(id,values)=>at(id).positionFrames=values;
  const scale=(id,values)=>at(id).scaleFrames=values;
  const blink=(id,height,start=25)=>scale(id,[[0,[100,height,100]],[start,[100,height,100]],[start+2,[100,8,100]],[start+4,[100,height,100]],[end,[100,height,100]]]);
  // The final authored transform is also the exact fallback pose. No state loops.
  if(state!=='paused'){blink(leftEye,rest.leftEye);blink(rightEye,rest.rightEye);}
  if(state==='available') {
    turn(right,[[0,-12],[8,-117],[14,-103],[20,-123],[26,-108],[end,rest.right]]);
    turn(head,[[0,0],[8,-4],[22,-4],[end,rest.head]]);
    scale(leftEye,[[0,[100,100,100]],[8,[100,110,100]],[21,[100,110,100]],[27,[100,8,100]],[31,[100,100,100]],[end,[100,100,100]]]);
    scale(rightEye,[[0,[100,100,100]],[8,[100,110,100]],[21,[100,110,100]],[27,[100,8,100]],[31,[100,100,100]],[end,[100,100,100]]]);
  } else if(state==='listening') {
    // Eye focus leads the head; the raised open palm reads at Perch size.
    move(leftEye,[[0,[-30,-1]],[4,[-34,-2]],[end,[-34,-2]]]);
    move(rightEye,[[0,[30,-1]],[4,[26,-2]],[end,[26,-2]]]);
    turn(head,[[0,0],[10,-10],[25,-10],[end,rest.head]]);
    turn(right,[[0,-18],[12,-157],[25,-157],[end,rest.right]]);
    turn(left,[[0,12],[12,19],[end,rest.left]]);
  } else if(state==='working') {
    // One focused glance between two work areas, then a readable held pose.
    turn(head,[[0,0],[9,5],[19,-3],[29,5],[end,rest.head]]);
    move(leftEye,[[0,[-30,-1]],[5,[-24,-5]],[17,[-35,-2]],[27,[-25,-4]],[end,[-25,-4]]]);
    move(rightEye,[[0,[30,-1]],[5,[36,-5]],[17,[25,-2]],[27,[35,-4]],[end,[35,-4]]]);
    move(leftLid,[[0,[-30,-16]],[5,[-24,-20]],[17,[-35,-17]],[27,[-25,-19]],[end,[-25,-19]]]);
    move(rightLid,[[0,[30,-16]],[5,[36,-20]],[17,[25,-17]],[27,[35,-19]],[end,[35,-19]]]);
    turn(left,[[0,12],[10,-23],[21,-10],[end,rest.left]]);
    turn(right,[[0,-12],[10,35],[21,19],[end,rest.right]]);
  } else if(state==='responding') {
    // Three syllable-sized articulations and an open-handed explanation.
    // First/last transforms match so a caller may repeat ONLY during real
    // output speech. This file itself has no loop or audio-level assumption.
    turn(head,[[0,rest.head],[7,-3],[15,1],[24,-3],[end,rest.head]]);
    move(head,[[0,[0,-46]],[7,[0,-48]],[15,[0,-46]],[24,[0,-48]],[end,[0,-46]]]);
    turn(left,[[0,rest.left],[9,55],[20,39],[end,rest.left]]);
    turn(right,[[0,rest.right],[8,-69],[19,-46],[28,-64],[end,rest.right]]);
    scale(mouth,[[0,[100,100,100]],[5,[105,130,100]],[10,[90,40,100]],[15,[110,145,100]],[21,[90,45,100]],[27,[105,120,100]],[end,[100,100,100]]]);
    scale(leftEye,[[0,[100,100,100]],[8,[100,88,100]],[16,[100,104,100]],[25,[100,100,100]],[27,[100,8,100]],[31,[100,100,100]],[end,[100,100,100]]]);
    scale(rightEye,[[0,[100,100,100]],[8,[100,96,100]],[16,[100,108,100]],[25,[100,100,100]],[27,[100,8,100]],[31,[100,100,100]],[end,[100,100,100]]]);
  } else if(state==='needs_you') {
    turn(right,[[0,-12],[11,-145],[21,-127],[end,rest.right]]);
    turn(head,[[0,0],[12,-6],[end,rest.head]]);
  } else if(state==='blocked') {
    turn(head,[[0,0],[10,6],[end,rest.head]]);
    turn(leftLid,[[0,0],[10,12],[end,12]]);
    turn(rightLid,[[0,0],[10,-6],[end,-6]]);
  } else if(state==='completed') {
    turn(left,[[0,12],[11,118],[23,118],[end,rest.left]]);
    turn(right,[[0,-12],[11,-122],[23,-122],[end,rest.right]]);
    move(body,[[0,[128,139]],[11,[128,134]],[23,[128,134]],[end,[128,139]]]);
    scale(badge,[[0,[70,70,100]],[12,[100,100,100]],[end,[100,100,100]]]);
  }
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
  return {ddd:0,ind:row.id,ty:4,nm:row.name,sr:1,...(row.parent?{parent:row.parent}:{}),ks:{
    o:row.opacityFrames?keys(row.opacityFrames):fixed(100),
    r:row.rotationFrames?keys(row.rotationFrames):fixed(row.rotation),
    p:row.positionFrames?keys(row.positionFrames.map(([t,v])=>[t,[...v,0]])):fixed([...row.position,0]),
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
  // Resolve final keyframes instead of duplicating pose values. This keeps every
  // static fallback identical to its clip's last frame as the rig evolves.
  const transform=(row)=>{
    const p=row.positionFrames?.at(-1)?.[1]??row.position;
    const r=row.rotationFrames?.at(-1)?.[1]??row.rotation;
    const s=row.scaleFrames?.at(-1)?.[1]??row.scale;
    return `translate(${p.join(' ')}) rotate(${r}) scale(${s[0]/100} ${s[1]/100})`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="none">${rows.map(row=>{
    if(row.opacityFrames?.at(-1)?.[1]===0)return '';
    const ancestors=[];let parent=row.parent;while(parent){const found=rows[parent-1];ancestors.unshift(found);parent=found.parent;}
    return [...ancestors,row].map(r=>`<g transform="${transform(r)}">`).join('')+row.items.map(itemSvg).join('')+'</g>'.repeat(ancestors.length+1);
  }).join('')}</svg>\n`;
}
await Promise.all([mkdir(web,{recursive:true}),mkdir(native,{recursive:true})]);
for(const theme of Object.keys(palettes))for(const state of states){
  const {rows,frames}=rig(state,theme);
  if(rows.length>32)throw new Error(`Layer budget exceeded: ${state}`);
  const data={v:'5.12.2',fr:30,ip:0,op:frames,w:256,h:256,nm:`ATLAS Scout voice presence · ${state} · ${theme}`,ddd:0,assets:[],layers:[...rows].reverse().map(row=>layer(row,frames)),markers:[{tm:0,cm:state,dr:frames}]};
  const json=`${JSON.stringify(data)}\n`;
  if(Buffer.byteLength(json)>128*1024)throw new Error(`Composition budget exceeded: ${state}`);
  await Promise.all([writeFile(resolve(web,`${state}-${theme}.json`),json),writeFile(resolve(native,`${state}-${theme}.json`),json),writeFile(resolve(web,`${state}-${theme}.svg`),poster(rows))]);
}
await writeFile(resolve(web,'provenance.json'),`${JSON.stringify({creativeRevision:revision,creator:'Original Asael ATLAS Scout vector rig',source:'.design/asael-ace-revamp/atlas-lottie/source/generate.mjs',designDirection:'Owner-approved Companion and Perch voice-presence motion study, 9 October 2026',format:'Lottie JSON; vector shape layers, parented character rig',frameRate:30,durationSeconds:1.2,loop:false,externalAssets:false,paletteSource:'src/app/globals.css and apps/flutter/lib/app/theme/app_theme.dart',states,references:[{title:'Robot standing',creator:'Penxel Studio',url:'https://lottiefiles.com/free-animation/robot-standing-cdB6OGVdsa',influence:'Historical reference: readable face and restrained blink'},{title:'Cute Bot Say Users Hello',creator:'Abdul Latif',url:'https://lottiefiles.com/free-animation/cute-bot-say-users-hello-fsKwsuIXi0',influence:'Historical reference: clear greeting silhouette'},{title:'Futuristic Robot Constructor',creator:'Tanjil Mahmud',url:'https://lottiefiles.com/free-animation/futuristic-robot-constructor-5FSNfVhxoG',influence:'Historical reference: articulated hand gesture'}],thirdPartyArtworkEmbedded:false},null,2)}\n`);
console.log(`Authored ${states.length*Object.keys(palettes).length} Scout clips and matching SVG poses (${revision}).`);
