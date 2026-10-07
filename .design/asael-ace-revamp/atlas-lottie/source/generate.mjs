// Original ATLAS vector artwork. Run from any directory to update both deliveries.
// This is a deterministic art authoring tool, not an application build or test.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const web = resolve(root, 'public/companion/atlas-lottie');
const native = resolve(root, 'apps/flutter/assets/companion/atlas-lottie');
const states = ['available', 'listening', 'working', 'responding', 'needs_you', 'blocked', 'completed', 'paused'];
const palettes = {
  light: { surface: '#FFFFFF', raised: '#F0EEEA', ink: '#242321', line: '#DDD8D0', gold: '#806019', wash: '#F5EBD3', success: '#286243', warning: '#805814' },
  dark: { surface: '#222325', raised: '#2B2C2F', ink: '#F4F1EA', line: '#3E4146', gold: '#E2BD74', wash: '#3C3222', success: '#91CFAC', warning: '#E7C37C' },
};
const fixed = (k) => ({ a: 0, k });
const color = (hex) => [...[1, 3, 5].map((n) => parseInt(hex.slice(n, n + 2), 16) / 255), 1];
const keyframes = (values) => ({ a: 1, k: values.map(([t, value], index) => ({ t, s: Array.isArray(value) ? value : [value], ...(index < values.length - 1 ? { e: Array.isArray(values[index + 1][1]) ? values[index + 1][1] : [values[index + 1][1]], i: { x: [.2], y: [1] }, o: { x: [.2], y: [0] } } : {}) })) });
const bezier = (v, closed = false, i = v.map(() => [0, 0]), o = v.map(() => [0, 0])) => ({ v, i, o, c: closed });
const ellipsePath = (rx, ry, start, end) => {
  const vertices = [], incoming = [], outgoing = [];
  const count = Math.ceil(Math.abs(end - start) / 45);
  for (let n = 0; n <= count; n++) {
    const angle = (start + (end - start) * n / count) * Math.PI / 180;
    const tangent = 4 / 3 * Math.tan((end - start) * Math.PI / 180 / count / 4);
    vertices.push([rx * Math.cos(angle), ry * Math.sin(angle)]);
    outgoing.push([-rx * Math.sin(angle) * tangent, ry * Math.cos(angle) * tangent]);
    incoming.push([rx * Math.sin(angle) * tangent, -ry * Math.cos(angle) * tangent]);
  }
  return bezier(vertices, false, incoming, outgoing);
};
const spark = bezier([[0,-40],[13,-13],[40,0],[13,13],[0,40],[-13,13],[-40,0],[-13,-13]], true,
  [[-3,0],[-6,-5],[0,-3],[5,-6],[3,0],[6,5],[0,3],[-5,6]],
  [[3,0],[5,6],[0,3],[-6,5],[-3,0],[-5,-6],[0,-3],[6,-5]]);

function scene(state, theme) {
  const p = palettes[theme];
  const shapes = [];
  const add = (name, shape, fill, stroke, width = 1, extra = {}) => shapes.push({ name, shape, fill, stroke, width, ...extra });
  const circle = (r) => ({ ellipse: [r * 2, r * 2] });
  const line = (points) => ({ path: bezier(points) });
  const arc = (rx, ry, start, end) => ({ path: ellipsePath(rx, ry, start, end) });
  add('Quiet halo', circle(91), p.wash, null, 0, { opacity: 42, pulse: state === 'listening' ? 1.06 : state === 'responding' ? 1.035 : 1 });
  add('Far orbit', arc(105, 69, -185, 85), null, p.line, 2, { rotation: -26 });
  add('Core outline', circle(66), p.surface, p.line, 1.5, { pulse: state === 'listening' ? 1.025 : 1 });
  add('Inner compass dial', circle(56), null, p.gold, .7, { opacity: 23 });
  add('South dial mark', line([[0,48],[0,52]]), null, p.gold, 1.5);
  add('West dial mark', line([[-52,0],[-48,0]]), null, p.gold, 1.5);
  add('North dial mark', line([[0,-52],[0,-48]]), null, p.gold, 1.5);
  add('East dial mark', line([[48,0],[52,0]]), null, p.gold, 1.5);
  add('Compass heart', { path: spark }, p.gold, null, 0, { rotation: -12, turn: state === 'working' ? 32 : state === 'available' ? 7 : 0, pulse: state === 'responding' ? 1.055 : 1 });
  add('Heart light', circle(4.5), p.surface, null);
  add('Near orbit', arc(105, 69, 15, 147), null, p.gold, 2.6, { rotation: -26, turn: state === 'working' ? 15 : 0 });
  const angle = -38 * Math.PI / 180;
  const satellite = [105 * Math.cos(angle), 69 * Math.sin(angle)];
  const rotation = -26 * Math.PI / 180;
  const satellitePosition = [satellite[0] * Math.cos(rotation) - satellite[1] * Math.sin(rotation), satellite[0] * Math.sin(rotation) + satellite[1] * Math.cos(rotation)];
  add('Satellite rim', circle(11), p.surface, null, 0, { position: satellitePosition, nudge: state === 'needs_you' ? [0,-5] : state === 'working' ? [5,3] : null });
  add('Guiding satellite', circle(6.5), p.gold, null, 0, { position: satellitePosition, nudge: state === 'needs_you' ? [0,-5] : state === 'working' ? [5,3] : null });
  if (state === 'listening') {
    add('Listening echo left', arc(76, 76, 148, 212), null, p.gold, 2, { pulse: 1.045, opacity: 65 });
    add('Listening echo right', arc(76, 76, -32, 32), null, p.gold, 2, { pulse: 1.045, opacity: 65 });
  }
  if (state === 'responding') {
    for (let n = 0; n < 3; n++) add(`Response note ${n + 1}`, line([[74+n*8,23-(n%2)*5],[74+n*8,34+(n%2)*5]]), null, p.gold, 3, { pulse: 1.06, delay: n * 2 });
  }
  if (['needs_you','blocked','paused','completed'].includes(state)) {
    const statusColor = state === 'completed' ? p.success : state === 'needs_you' || state === 'blocked' ? p.warning : p.ink;
    add('Status badge surface', circle(19), p.surface, p.line, 1, { position: [59, 59] });
    if (state === 'completed') {
      add('Verified completion', line([[-8,0],[-2,6],[9,-7]]), null, statusColor, 3, { position: [59,59], reveal: true });
      add('Completion glint', { path: bezier([[0,-6],[2,-2],[6,0],[2,2],[0,6],[-2,2],[-6,0],[-2,-2]],true) }, p.gold, null, 0, { position: [-70,-57], pulse: 1.2 });
    } else if (state === 'paused') {
      add('Pause left', line([[-4,-6],[-4,6]]), null, statusColor, 3, { position: [59,59] });
      add('Pause right', line([[4,-6],[4,6]]), null, statusColor, 3, { position: [59,59] });
    } else {
      add('Attention line', line([[0,-7],[0,2]]), null, statusColor, 2.7, { position: [59,59] });
      add('Attention point', circle(1.7), statusColor, null, 0, { position: [59,66] });
    }
  }
  return shapes;
}

function layer(row, index, frames) {
  const middle = Math.floor(frames * .45), end = frames - 1;
  const position = row.position ?? [0,0];
  const ks = {
    o: row.reveal ? keyframes([[0,0],[4,100],[end,100]]) : fixed(row.opacity ?? 100),
    r: row.turn ? keyframes([[0,row.rotation ?? 0],[middle,(row.rotation ?? 0)+row.turn],[end,row.rotation ?? 0]]) : fixed(row.rotation ?? 0),
    p: row.nudge ? keyframes([[0,[128+position[0],128+position[1],0]],[middle,[128+position[0]+row.nudge[0],128+position[1]+row.nudge[1],0]],[end,[128+position[0],128+position[1],0]]]) : fixed([128+position[0],128+position[1],0]),
    a: fixed([0,0,0]),
    s: row.pulse && row.pulse !== 1 ? keyframes([[0,[100,100,100]],[middle+(row.delay ?? 0),[row.pulse*100,row.pulse*100,100]],[end,[100,100,100]]]) : fixed([100,100,100]),
  };
  const items = [row.shape.ellipse ? {ty:'el',d:1,s:fixed(row.shape.ellipse),p:fixed([0,0]),nm:row.name} : {ty:'sh',ks:fixed(row.shape.path),nm:row.name}];
  if (row.fill) items.push({ty:'fl',c:fixed(color(row.fill)),o:fixed(100),r:1,nm:'Fill'});
  if (row.stroke) items.push({ty:'st',c:fixed(color(row.stroke)),o:fixed(100),w:fixed(row.width),lc:2,lj:2,ml:4,nm:'Stroke'});
  return {ddd:0,ind:index,ty:4,nm:row.name,sr:1,ks,ao:0,shapes:items,ip:0,op:frames,st:0,bm:0};
}

function pathSvg(path) {
  let d = `M ${path.v[0].join(' ')}`;
  const last = path.c ? path.v.length : path.v.length - 1;
  for (let n = 0; n < last; n++) {
    const next = (n+1) % path.v.length;
    const a = path.v[n], b = path.v[next];
    d += ` C ${a[0]+path.o[n][0]} ${a[1]+path.o[n][1]} ${b[0]+path.i[next][0]} ${b[1]+path.i[next][1]} ${b.join(' ')}`;
  }
  return d + (path.c ? ' Z' : '');
}
function poster(rows) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="none">${rows.map((row) => {
    const [x,y] = row.position ?? [0,0];
    const attrs = `fill="${row.fill ?? 'none'}" stroke="${row.stroke ?? 'none'}" stroke-width="${row.width}" stroke-linecap="round" stroke-linejoin="round" opacity="${(row.opacity ?? 100)/100}" transform="translate(${128+x} ${128+y}) rotate(${row.rotation ?? 0})"`;
    return row.shape.ellipse ? `<ellipse rx="${row.shape.ellipse[0]/2}" ry="${row.shape.ellipse[1]/2}" ${attrs}/>` : `<path d="${pathSvg(row.shape.path)}" ${attrs}/>`;
  }).join('')}</svg>\n`;
}

await Promise.all([mkdir(web,{recursive:true}),mkdir(native,{recursive:true})]);
for (const theme of Object.keys(palettes)) {
  for (const state of states) {
    const rows = scene(state, theme), frames = state === 'completed' ? 24 : 21;
    const data = {v:'5.12.2',fr:30,ip:0,op:frames,w:256,h:256,nm:`ATLAS · ${state} · ${theme}`,ddd:0,assets:[],layers:[...rows].reverse().map((row,index)=>layer(row,index+1,frames)),markers:[{tm:0,cm:state,dr:frames}]};
    const json = `${JSON.stringify(data)}\n`;
    await Promise.all([writeFile(resolve(web,`${state}-${theme}.json`),json),writeFile(resolve(native,`${state}-${theme}.json`),json),writeFile(resolve(web,`${state}-${theme}.svg`),poster(rows))]);
  }
}
await writeFile(resolve(web,'provenance.json'),`${JSON.stringify({creativeRevision:'atlas-orbit-20261007',creator:'Original Asael ATLAS vector artwork',source:'.design/asael-ace-revamp/atlas-lottie/source/generate.mjs',format:'Lottie JSON; vector shape layers only',frameRate:30,externalAssets:false,paletteSource:'src/app/globals.css and apps/flutter/lib/app/theme/app_theme.dart',states},null,2)}\n`);
