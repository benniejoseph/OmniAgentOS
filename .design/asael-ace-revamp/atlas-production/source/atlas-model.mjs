/** ATLAS sculpt 04, eyelid 03 — unreviewed interior lid clearance correction.
 * No raster planes, generated imagery, physics, audio, providers or app imports.
 * Geometry is deterministic; Three UUIDs are internal and not provenance IDs.
 */
import * as THREE from 'three';

const DEG = Math.PI / 180;
const clamp = (n) => Math.min(1, Math.max(0, n));
const quaternion = (degrees) => new THREE.Quaternion().setFromEuler(new THREE.Euler(...degrees.map((v) => v * DEG)));
// A softly squared front face supports inset eyes without adding protruding
// orbital rings. Nape, crown and lower neck remain rounded.
function frontContour(y,value) {
  if(value<=0)return value;
  const face=Math.min(clamp((y-2.59)/.10),clamp((2.96-y)/.08));
  return Math.pow(value,1-.50*face);
}

function geometry(positions, indices) {
  const value = new THREE.BufferGeometry();
  value.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  value.setIndex(indices);
  value.computeVertexNormals();
  return value;
}

/** Elliptical horizontal sections, capped; profile rows: Y, radiusX, radiusZ, centerZ. */
function loft(profile, segments, sculptFace=false) {
  const positions = [], indices = [];
  for (const [y, rx, rz, cz = 0] of profile) {
    for (let n = 0; n < segments; n++) {
      const angle = n * 2 * Math.PI / segments;
      positions.push(rx * Math.cos(angle), y, cz + rz * (sculptFace?frontContour(y,Math.sin(angle)):Math.sin(angle)));
    }
  }
  for (let row = 0; row < profile.length - 1; row++) {
    for (let n = 0; n < segments; n++) {
      const a = row * segments + n, b = row * segments + (n + 1) % segments;
      const c = b + segments, d = a + segments;
      indices.push(a, d, b, b, d, c);
    }
  }
  const bottom = positions.length / 3;
  positions.push(0, profile[0][0], profile[0][3] || 0);
  const top = positions.length / 3;
  positions.push(0, profile.at(-1)[0], profile.at(-1)[3] || 0);
  for (let n = 0; n < segments; n++) {
    indices.push(bottom, n, (n + 1) % segments);
    const last = (profile.length - 1) * segments;
    indices.push(top, last + (n + 1) % segments, last + n);
  }
  return geometry(positions, indices);
}

/** Rounded throat-02 contour, used only as color on the existing front neck. */
function throatMask(profile) {
  const curve=new THREE.CatmullRomCurve3(profile.map(([y,width])=>new THREE.Vector3(width,y,0)),false,'centripetal');
  const contour=Array.from({length:81},(_,row)=>{const point=curve.getPoint(row/80);return [point.y,point.x];});
  const low=profile[0][0],high=profile.at(-1)[0];
  return ({x,y,z})=>{
    if(z<=0||y<low-.08||y>high+.08)return 0;
    // Invert the previous patch's rounded, sideways sweep at this neck vertex.
    let lower=low,upper=high;
    for(let step=0;step<12;step++) {
      const baseY=(lower+upper)/2,width=profileAt(contour,baseY)[1];
      const flow=clamp((2.69-baseY)/.50),top=clamp((baseY-2.60)/.085);
      const t=Math.max(-1,Math.min(1,(x+.070*flow*flow)/width));
      const mappedY=baseY+.050*t*flow+.055*t*t*flow-.024*t*t*top;
      if(mappedY<y)lower=baseY;else upper=baseY;
    }
    const baseY=(lower+upper)/2,width=profileAt(contour,baseY)[1],flow=clamp((2.69-baseY)/.50);
    const t=(x+.070*flow*flow)/width;
    const distance=Math.min((1-Math.abs(t))*width,(baseY-low)*.85,(high-baseY)*1.30);
    // Cover several refined shell rows and the coarser underlying vertices.
    const fade=clamp(distance/.060);
    return fade*fade*(3-2*fade);
  };
}

// Z, mouth-edge Y, half-width, ridge height. The broad mouth corners end
// before the narrow descending hook; increasing Z avoids a folded-back tip ring.
const beakSections=[[.246,2.648,.071,.095],[.292,2.628,.119,.126],[.339,2.615,.150,.136],
  [.381,2.595,.146,.143],[.432,2.577,.083,.128],[.478,2.546,.039,.109],
  [.512,2.512,.024,.079],[.533,2.476,.017,.051],[.544,2.448,.010,.026],[.547,2.432,.002,.006]];

/** A rounded projecting culmen narrows into a continuous descending hook. */
function upperBeak() {
  const ridgeForward=[.012,.030,.049,.067,.075,.061,.043,.028,.019,.012];
  const section=[[1,0],[.84,.28],[.34,.58],[.12,.92],[0,1],[-.12,.92],[-.34,.58],[-.84,.28],[-1,0],[-.77,-.18],[0,-.25],[.77,-.18]];
  const rings=[],tones=[];
  for(let row=0;row<beakSections.length;row++) {
    const [z,y,rx,ry]=beakSections[row];
    rings.push(section.flatMap(([x,h])=>{
      const crest=(1-Math.abs(x))**2*Math.max(0,h);
      return [x*rx,y+h*ry,z+(1-Math.abs(x))*.012+(ridgeForward[row]-.012)*crest];
    }));
    for(const [x,h] of section)tones.push(.72+.23*Math.max(0,h)+.04*(1-Math.abs(x))-.07*clamp((row-5)/4));
  }
  return ringMesh(rings,section.length,tones);
}

function mandible() {
  // Fit the upper lip's concave underside instead of placing a round blade
  // below it. The whole thin shell still belongs to the existing Jaw bone.
  const contact=[[1,0],[.77,-.18],[0,-.25],[-.77,-.18],[-1,0]];
  const thickness=[.014,.020,.022,.020,.016,.010,.004];
  const rings=beakSections.slice(0,7).map(([z,y,rx,ry],row)=>{
    const top=contact.map(([x,h])=>[x*rx,y+h*ry-.0015,z+(1-Math.abs(x))*.012]);
    return [...top,...top.map(([x,y,z])=>[x,y-thickness[row],z]).reverse()].flat();
  });
  const result=ringMesh(rings,10);
  // Pair top/bottom cap strips: a vertex-0 fan would cross the concave trough.
  const indices=Array.from(result.index.array).slice(0,(rings.length-1)*10*6);
  for(let n=0;n<4;n++) {
    const a=n,b=n+1,c=9-n,d=8-n,end=(rings.length-1)*10;
    indices.push(a,c,b,b,c,d,end+a,end+b,end+c,end+b,end+d,end+c);
  }
  result.setIndex(indices);
  result.computeVertexNormals();
  return result;
}

// Broad buried roots and an extended taper avoid the bulbous middle of a leaf.
const vaneProfile=[[0,.96],[.18,1],[.37,.90],[.57,.76],[.76,.56],[.91,.31],[.98,.10],[1,.006]];
function ringMesh(rings, sides, tones) {
  const positions=rings.flat(),indices=[];
  for(let row=0;row<rings.length-1;row++) for(let n=0;n<sides;n++) {
    const a=row*sides+n,b=row*sides+(n+1)%sides;
    indices.push(a,b,a+sides,b,b+sides,a+sides);
  }
  for(let n=1;n<sides-1;n++) {
    indices.push(0,n+1,n);const end=(rings.length-1)*sides;indices.push(end,end+n,end+n+1);
  }
  const result=geometry(positions,indices);
  if(tones)result.setAttribute('tone',new THREE.Float32BufferAttribute(tones,1));
  return result;
}

/** Broad buried root, asymmetric convex vanes, a curved shaft and narrow tip. */
function feather(length=1,width=.12,depth=.04,sweep=0,curl=.015) {
  const rings=[],tones=[],sides=8;
  for(const [t,envelope] of vaneProfile) {
    const ring=[];
    for(let n=0;n<sides;n++) {
      const a=n*2*Math.PI/sides,side=Math.cos(a),front=Math.sin(a);
      ring.push(sweep*(.28*Math.sin(Math.PI*t)+t*t)+width*envelope*side*(side<0?.87:1),-length*t,
        curl*t*t+depth*envelope*front*(front<0?.30:1));
      tones.push(.95+.055*t+.025*Math.max(0,front));
    }
    rings.push(ring);
  }
  return ringMesh(rings,sides,tones);
}

/** Shallow continuous feather grain: no repeated raised plates on the torso. */
function plumageShell(profile,low,high,rows=60,sides=112) {
  const positions=[],indices=[],tones=[],levels=[];
  // Refine only the final fourteen neck bands. With the existing 60/112 grid,
  // one band is halved and thirteen are divided into thirds: +27 rows.
  for(let row=0;row<rows;row++) {
    const divisions=row>rows-14?3:row===rows-14?2:1;
    for(let step=0;step<divisions;step++)levels.push(low+(high-low)*(row+step/divisions)/rows);
  }
  levels.push(high);
  for(let row=0;row<levels.length;row++) {
    const y=levels[row],[,rx,rz,cz]=profileAt(profile,y);
    const boundary=Math.min(clamp((y-low)/.11),clamp((high-y)/.11));
    for(let n=0;n<sides;n++) {
      const angle=n*2*Math.PI/sides;
      const phase=28*angle+3.6*y+.8*Math.sin(3*angle-1.7*y);
      const shaft=Math.max(0,Math.cos(phase))**4;
      const layer=.5+.5*Math.cos(26*y+1.1*Math.sin(phase)+.8*Math.sin(3*angle));
      const relief=.0008+boundary*(.0022+.006*shaft*(.35+.65*layer));
      const outward=new THREE.Vector3(Math.sin(angle)/rx,0,Math.cos(angle)/rz).normalize();
      positions.push(rx*Math.sin(angle)+outward.x*relief,y,
        cz+rz*frontContour(y,Math.cos(angle))+outward.z*relief);
      tones.push(1+boundary*(-.03+.045*shaft+.012*layer));
    }
  }
  for(let row=0;row<levels.length-1;row++)for(let n=0;n<sides;n++) {
    const a=row*sides+n,b=row*sides+(n+1)%sides;indices.push(a,b,a+sides,b,b+sides,a+sides);
  }
  const result=geometry(positions,indices);
  result.setAttribute('tone',new THREE.Float32BufferAttribute(tones,1));
  return result;
}

/** A low sculpted tuft has three unequal tips, rather than one repeated leaf. */
function plumageTuft(profile,y,angle,length,width,sweep=0,lift=.004) {
  const positions=[],indices=[],tones=[],across=12,rows=5;
  for(let row=0;row<=rows;row++)for(let n=0;n<=across;n++) {
    const t=row/rows,u=n/across*2-1;
    const tip=.11*Math.cos(u*3*Math.PI)+.035*u;
    const sampleY=y-length*t*(1+tip*t*t),a=angle+sweep*t*t;
    const [,rx,rz,cz]=profileAt(profile,sampleY);
    const tangent=new THREE.Vector3(rx*Math.cos(a),0,-rz*Math.sin(a)).normalize();
    const outward=new THREE.Vector3(Math.sin(a)/rx,0,Math.cos(a)/rz).normalize();
    const point=new THREE.Vector3(rx*Math.sin(a),sampleY,cz+rz*frontContour(sampleY,Math.cos(a)));
    point.addScaledVector(tangent,width*u*(1-.46*t));
    point.addScaledVector(outward,lift+.012*Math.sin(t*Math.PI*.75)*(1-.55*u*u));
    positions.push(...point.toArray());tones.push(.975+.022*t+.012*(1-u*u));
  }
  for(let row=0;row<rows;row++)for(let n=0;n<across;n++) {
    const a=row*(across+1)+n,b=a+1,d=a+across+1;indices.push(a,b,d,b,d+1,d);
  }
  const result=geometry(positions,indices);
  result.setAttribute('tone',new THREE.Float32BufferAttribute(tones,1));
  return result;
}

/** A close-fitting sloped band, with an overlapping front, not a level ring. */
function collarBand(profile,top=false) {
  const positions=[],indices=[],sides=64,rows=top?1:3;
  for(let row=0;row<=rows;row++)for(let n=0;n<sides;n++) {
    const a=n*2*Math.PI/sides,t=row/rows;
    const y=2.257-.077*Math.max(0,Math.cos(a))+.037*Math.sin(a)-(top?.006:.067)*(1-t);
    const [,rx,rz,cz]=profileAt(profile,y);
    const normal=new THREE.Vector3(Math.sin(a)/rx,0,Math.cos(a)/rz).normalize();
    const lift=top?.0205:.019;
    positions.push(rx*Math.sin(a)+normal.x*lift,y,cz+rz*Math.cos(a)+normal.z*lift);
  }
  for(let row=0;row<rows;row++)for(let n=0;n<sides;n++) {
    const a=row*sides+n,b=row*sides+(n+1)%sides;indices.push(a,b,a+sides,b,b+sides,a+sides);
  }
  return geometry(positions,indices);
}

/** Curved solid sweep used for authored crown blades and articulated toes. */
function sweepVolume(points,widths,depths,steps=12,sides=8,blade=false) {
  const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p)),false,'centripetal');
  const rings=[],tones=[];
  const referenceHint=Math.abs(curve.getTangent(0).x)>.75?new THREE.Vector3(0,0,1):new THREE.Vector3(1,0,0);
  for(let row=0;row<=steps;row++) {
    const t=row/steps,center=curve.getPoint(t),tangent=curve.getTangent(t).normalize();
    const reference=referenceHint.clone();
    const across=reference.addScaledVector(tangent,-reference.dot(tangent)).normalize();
    const normal=new THREE.Vector3().crossVectors(tangent,across).normalize();
    const scaled=t*(widths.length-1),index=Math.min(widths.length-2,Math.floor(scaled)),mix=scaled-index;
    const width=widths[index]*(1-mix)+widths[index+1]*mix,depth=depths[index]*(1-mix)+depths[index+1]*mix;
    const ring=[];
    for(let n=0;n<sides;n++) {
      const a=n*2*Math.PI/sides;
      const p=center.clone().addScaledVector(across,width*Math.cos(a)).addScaledVector(normal,depth*Math.sin(a));
      ring.push(...p.toArray());tones.push(blade?.96+.065*t:1);
    }
    rings.push(ring);
  }
  return ringMesh(rings,sides,tones);
}

/** The visible sclera is an almond, not a sphere framed by concentric rings. */
const eyeWidth=.129,eyeUpper=.069,eyeLower=.058,lidUpper=.039;
const eyeEdge=x=>Math.sin((clamp((x/eyeWidth+1)/2))*Math.PI)**.72;
const eyeSag=(x,side)=>-.075*clamp(side*x/eyeWidth)**2;
function eyeDepth(x,y,side) {
  const edge=eyeEdge(x),height=(y>0?eyeUpper:eyeLower)*edge;
  return eyeSag(x,side)+.010+.024*edge*(1-Math.min(1,(y/Math.max(.0001,height))**2));
}
function eyeSurface(side) {
  const positions=[],indices=[],across=24,rows=8;
  for(let row=0;row<=rows;row++) for(let n=0;n<=across;n++) {
    const u=n/across*2-1,v=row/rows*2-1,edge=Math.sin((u+1)*Math.PI/2)**.72;
    const x=u*eyeWidth,y=v*(v>0?eyeUpper:eyeLower)*edge;
    positions.push(x,y,eyeDepth(x,y,side));
  }
  for(let row=0;row<rows;row++) for(let n=0;n<across;n++) {
    const a=row*(across+1)+n,b=a+1,d=a+across+1,c=d+1;indices.push(a,b,d,b,c,d);
  }
  return geometry(positions,indices);
}

/** Large iris follows the curved globe; the mobile lid covers its upper edge. */
function eyeDisc(rx,ry,cx,cy,offset,side) {
  const positions=[cx,cy,eyeDepth(cx,cy,side)+offset],indices=[],sides=40,rows=4;
  for(let row=1;row<=rows;row++)for(let n=0;n<sides;n++) {
    const a=n*2*Math.PI/sides,dx=rx*Math.cos(a),dy=ry*Math.sin(a);
    let low=0,high=1;
    for(let step=0;step<12;step++) {
      const t=(low+high)/2,x=cx+dx*t,y=cy+dy*t;
      if(Math.abs(x)<=eyeWidth&&y<=eyeUpper*eyeEdge(x)&&y>=-eyeLower*eyeEdge(x))low=t;else high=t;
    }
    const scale=low*row/rows,x=cx+dx*scale,y=cy+dy*scale;
    positions.push(x,y,eyeDepth(x,y,side)+offset);
  }
  for(let n=0;n<sides;n++)indices.push(0,1+n,1+(n+1)%sides);
  for(let row=0;row<rows-1;row++)for(let n=0;n<sides;n++) {
    const a=1+row*sides+n,b=1+row*sides+(n+1)%sides;indices.push(a,b,a+sides,b,b+sides,a+sides);
  }
  return geometry(positions,indices);
}

/** A soft lid grows back into the face; only a thin inner seam stays visible. */
function eyelid(side,upper=true,seam=false,hinge=null) {
  const positions=[],indices=[],headWeights=[],across=24,rows=seam?1:4;
  const closeCos=Math.cos(68*DEG),closeSin=Math.sin(68*DEG);
  for(let row=0;row<=rows;row++) for(let n=0;n<=across;n++) {
    const u=n/across*2-1,v=row/rows,edge=Math.sin((u+1)*Math.PI/2)**.72;
    const inner=(upper?lidUpper:-eyeLower)*edge,x=u*(eyeWidth+v*(seam?.001:.025));
    const depth=upper
      ?.005+.032*edge-(seam?-.0005:.060*v**4)+Math.sin(Math.PI*v)*(seam?0:.005)
      :.014+.003*edge-v*(seam?-.0005:.044)+Math.sin(Math.PI*v)*(seam?0:.006);
    const localY=inner+(upper?1:-1)*v*(seam?.0015:.034*edge+.006);
    let z=eyeSag(x,side)+depth;
    if(upper) {
      const root=seam?0:clamp((v-.25)/.50),rimX=u*eyeWidth,rimY=lidUpper*edge;
      const [hingeY,hingeZ]=hinge,targetY=-(eyeLower+.002)*edge;
      // Fit each column to the lower aperture at the existing 68-degree peak.
      // The surface guard also places the stationary canthi ahead of sclera.
      const surfaceZ=eyeDepth(rimX,rimY,side)+.004;
      const fittedZ=hingeZ+((rimY-hingeY)*closeCos-(targetY-hingeY))/closeSin;
      const rimZ=edge<.0001?surfaceZ:Math.max(surfaceZ,fittedZ);
      const closedY=hingeY+(rimY-hingeY)*closeCos-(rimZ-hingeZ)*closeSin;
      const mobile=edge<.0001?0:clamp((targetY-rimY)/(closedY-rimY));
      z+=(rimZ-(eyeSag(rimX,side)+.005+.032*edge))*(1-root);
      const head=Math.max(root,1-mobile);
      if(!seam&&v>0&&v<1) {
        // The fitted edge alone does not keep the bridge over the curved eye.
        // Guard existing interior rows in both neutral and peak-closure poses;
        // use the aperture column so the bridge to the canthus stays covered.
        const moving=1-head,clearance=.006+.002*edge;
        for(let fit=0;fit<3;fit++) {
          const posedY=localY+moving*((localY-hingeY)*(closeCos-1)-(z-hingeZ)*closeSin);
          const posedZ=z+moving*((localY-hingeY)*closeSin+(z-hingeZ)*(closeCos-1));
          const restGap=eyeDepth(rimX,localY,side)+clearance-z;
          const closedGap=eyeDepth(rimX,posedY,side)+clearance-posedZ;
          z+=Math.max(0,restGap,closedGap/(1-moving*(1-closeCos)));
        }
      }
      headWeights.push(head);
    }
    positions.push(x,localY,z);
  }
  for(let row=0;row<rows;row++) for(let n=0;n<across;n++) {
    const a=row*(across+1)+n,b=a+1,d=a+across+1,c=d+1;indices.push(a,b,d,b,c,d);
  }
  const result=geometry(positions,indices);
  if(upper)result.setAttribute('lidHeadWeight',new THREE.Float32BufferAttribute(headWeights,1));
  return result;
}

function profileAt(profile, y) {
  const upper=profile.findIndex(row=>row[0]>=y);
  if(upper<0)return profile.at(-1);
  if(upper<=0)return profile[Math.max(0,upper)];
  const a=profile[upper-1],b=profile[upper],t=(y-a[0])/(b[0]-a[0]);
  return a.map((value,index)=>value+(b[index]-value)*t);
}

export function createAtlas(config) {
  if (config.schemaVersion !== 1 || config.name !== 'ATLAS_ROUGH_01') throw Error('Unexpected rough model contract.');
  const root = new THREE.Group(); root.name = config.name;
  const byName = new Map(), worldRest = new Map(), boneIndex = new Map();
  const bones = config.rig.map((definition, index) => {
    const bone = new THREE.Bone(); bone.name = definition.name;
    const rest = new THREE.Vector3(...definition.position);
    bone.position.copy(rest);
    if (definition.parent) {
      const parent = byName.get(definition.parent);
      if (!parent) throw Error('Rig parents must precede children.');
      bone.position.sub(worldRest.get(definition.parent)); parent.add(bone);
    } else root.add(bone);
    byName.set(definition.name, bone); worldRest.set(definition.name, rest); boneIndex.set(definition.name, index);
    return bone;
  });
  const p = [], n = [], colors = [], joints = [], weights = [], indices = [], parts = [];
  const color = new THREE.Color(), point = new THREE.Vector3(), normal = new THREE.Vector3();
  const throatWeight=throatMask(config.throatProfile);
  const spineWeight = (y) => {
    if (y < 0.65) return [['Root', 1]];
    if (y < 1.96) return [['Spine', 1]];
    const neck = clamp((y - 1.96) / 0.35), head = clamp((y - 2.39) / 0.21);
    return head > 0 ? [['Neck',1-head],['Head',head]] : [['Spine',1-neck],['Neck',neck]];
  };
  function append(name, mesh, shade, bone, position = [0,0,0], scale = [1,1,1], rotation = [0,0,0]) {
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(...position), quaternion(rotation), new THREE.Vector3(...scale));
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix), offset = p.length / 3;
    const vertices = mesh.getAttribute('position'), normals = mesh.getAttribute('normal'), tones=mesh.getAttribute('tone');
    const lidHeadWeights=bone==='UpperLidLeft'||bone==='UpperLidRight'?mesh.getAttribute('lidHeadWeight'):null;
    color.set(config.palette[shade]);
    const hasThroat=name==='continuous_eagle_silhouette'||name==='continuous_directional_plumage';
    const throatPale=hasThroat?new THREE.Color(config.palette.throat):null,throatColor=hasThroat?color.clone():null;
    for (let i = 0; i < vertices.count; i++) {
      point.fromBufferAttribute(vertices, i).applyMatrix4(matrix);
      normal.fromBufferAttribute(normals, i).applyMatrix3(normalMatrix).normalize();
      const tone=tones?.getX(i)??1;
      const vertexColor=throatColor?throatColor.copy(color).lerp(throatPale,throatWeight(point)):color;
      p.push(point.x,point.y,point.z); n.push(normal.x,normal.y,normal.z); colors.push(vertexColor.r*tone,vertexColor.g*tone,vertexColor.b*tone);
      const influences = lidHeadWeights
        ? [['Head',lidHeadWeights.getX(i)],[bone,1-lidHeadWeights.getX(i)]]
        : typeof bone === 'function' ? bone(point.y) : [[bone,1]];
      for (let slot = 0; slot < 4; slot++) { joints.push(influences[slot] ? boneIndex.get(influences[slot][0]) : 0); weights.push(influences[slot]?.[1] || 0); }
    }
    for (let i = 0; i < mesh.index.count; i++) indices.push(offset + mesh.index.getX(i));
    parts.push({name,vertexStart:offset,vertexCount:vertices.count}); mesh.dispose();
  }
  const ellipsoid = (name, shade, bone, position, scale, rotation = [0,0,0], segments = 16) =>
    append(name, new THREE.SphereGeometry(1,segments,10), shade,bone,position,scale,rotation);
  // Higher shoulders shorten the exposed neck. Fine continuous grain supplies
  // the body texture; a few low tufts describe the direction of the plumage.
  const silhouette=[...config.bodyProfile.filter(row=>row[0]<config.headProfile[0][0]),...config.headProfile];
  // Additional neck rows sample the existing profile so its underlying color
  // follows the same mask as the feather shell, including the blended edge.
  const coloredSilhouette=silhouette.flatMap((section,index)=>{
    const next=silhouette[index+1];
    const steps=next&&section[0]<2.75&&next[0]>2.11?Math.ceil((next[0]-section[0])/.020):1;
    return Array.from({length:steps},(_,step)=>profileAt(silhouette,section[0]+(next?next[0]-section[0]:0)*step/steps));
  });
  append('continuous_eagle_silhouette',loft(coloredSilhouette,config.radialSegments,true),'umber',spineWeight);
  append('continuous_directional_plumage',plumageShell(silhouette,.46,2.68),'umber',spineWeight);

  const breastTufts=[[2.13,.38,.21,.067,.12],[2.04,.78,.25,.076,.15],[1.94,.13,.19,.061,.09],
    [1.85,.57,.23,.074,.16],[1.72,.95,.24,.072,.18],[1.64,.29,.21,.065,.11],
    [1.47,.72,.23,.075,.16],[1.31,.11,.20,.066,.09],[1.18,.49,.24,.071,.14],
    [1.03,.87,.24,.067,.18],[.90,.29,.20,.059,.11],[.71,.58,.19,.053,.13]];
  for(const side of [-1,1])for(let j=0;j<breastTufts.length;j++) {
    const [y,a,length,width,sweep]=breastTufts[j];
    append(`breast_flow_tuft_${side}_${j}`,plumageTuft(silhouette,y+(side===1?.025:0),side*a,length,width,side*sweep),'umber',spineWeight);
  }
  const backTufts=[[2.62,1.42,.20,.052],[2.50,1.98,.22,.062],[2.39,2.56,.24,.066],
    [2.24,1.59,.25,.071],[2.12,2.93,.25,.072],[1.94,2.22,.25,.072],
    [1.71,2.64,.24,.074],[1.47,1.82,.26,.073],[1.24,2.91,.23,.067],[.98,2.17,.23,.060]];
  for(const side of [-1,1])for(let j=0;j<backTufts.length;j++) {
    const [y,a,length,width]=backTufts[j];
    append(`mantle_flow_tuft_${side}_${j}`,plumageTuft(silhouette,y,side*a,length,width,side*.14),'umber',spineWeight);
  }
  // The pale cheek edge is color on the neck itself; no sheet or loose strips.
  append('charcoal_collar',collarBand(silhouette),'collar','Neck');
  append('collar_upper_stitch',collarBand(silhouette,true),'collarEdge','Neck');
  append('collar_overlap',geometry([-.166,2.162,.282,-.063,2.144,.304,-.091,2.068,.329,-.182,2.105,.305],[0,1,2,0,2,3]),'collar','Neck');
  append('collar_tab',geometry([-.151,2.116,.304,-.089,2.074,.326,-.156,2.012,.313,-.214,2.075,.285],[0,1,2,0,2,3]),'collarEdge','Neck');
  append('upper_hooked_beak',upperBeak(),'beakLight','Head');
  append('lower_beak',mandible(),'gold','Jaw');
  for (const side of [-1,1]) {
    const suffix = side === 1 ? 'Left' : 'Right';
    const eye=[side*.180,2.761,.258];
    const lidPivot=worldRest.get(`UpperLid${suffix}`),lidHinge=[lidPivot.y-eye[1],lidPivot.z-eye[2]];
    append(`almond_eye_${suffix}`,eyeSurface(side),'eyeWhite','Head',eye);
    append(`iris_${suffix}`,eyeDisc(.058,.064,-side*.010,-.006,.0015,side),'iris','Head',eye);
    append(`pupil_${suffix}`,eyeDisc(.024,.035,-side*.010,-.006,.003,side),'pupil','Head',eye);
    ellipsoid(`eye_highlight_${suffix}`,'eyeWhite','Head',[side*.159,2.769,.296],[.0065,.008,.0015],[0,0,0],12);
    append(`soft_upper_lid_${suffix}`,eyelid(side,true,false,lidHinge),'umber',`UpperLid${suffix}`,eye);
    append(`upper_lid_seam_${suffix}`,eyelid(side,true,true,lidHinge),'umber',`UpperLid${suffix}`,eye);
    append(`soft_lower_lid_${suffix}`,eyelid(side,false),'umber','Head',eye);
    // Lift the inner brow enough to read as poised attention, not an eye mask.
    append(`neutral_brow_sweep_${suffix}`,sweepVolume([[side*.065,2.818,.254],[side*.147,2.840,.259],[side*.240,2.837,.228],[side*.331,2.816,.140]],
      [.020,.027,.025,.002],[.014,.020,.016,.001],16,8,true),'umber',`Brow${suffix}`);
    for(let j=0;j<2;j++) append(`temple_tuft_${suffix}_${j}`,plumageTuft(silhouette,2.817-j*.073,side*(1.08+j*.25),.16,.040,side*.18),
      'umber','Head');
    // A combed crown: broad roots travel over the cranium and turn upward only
    // at the rear tips. A handful of authored sweeps replaces the radial spikes.
    for(let j=0;j<3;j++) append(`authored_crown_${suffix}_${j}`,sweepVolume([
      [side*(.035+j*.078),2.962-j*.027,.125-j*.020],
      [side*(.054+j*.070),3.027-j*.025,.025-j*.020],
      [side*(.108+j*.058),3.047-j*.026,-.129-j*.030],
      [side*(.188+j*.037),3.072-j*.019,-.247-j*.048]],
      [.069-j*.008,.067-j*.007,.037-j*.003,.0015],[.017,.022,.015,.001],14,8,true),'umber','Head');
    ellipsoid(`nostril_${suffix}`,'beakShadow','Head',[side*.101,2.666,.323],[.012,.005,.004],[0,side*30,side*12],12);

    ellipsoid(`folded_wing_underform_${suffix}`,'umber',`Wing${suffix}`,[side*.445,1.601,-.065],[.167,.493,.177],[0,0,side*8],20);
    for(let row=0;row<3;row++) for(let j=0;j<4;j++) append(`layered_wing_covert_${suffix}_${row}_${j}`,
      feather(.39+row*.063-j*.019,.072-row*.007,.014,side*(.022+j*.011),.022),'umber',`Wing${suffix}`,
      [side*(.421+j*.038),2.033-row*.181-j*.058,.115-j*.088+row*.002],[1,1,1],[10,side*(-12+j*28),side*(-6+j*3)]);
    for(let j=0;j<8;j++) append(`curved_primary_${suffix}_${j}`,feather(.85-j*.023,.050,.013,side*(.017+j*.003),.023),j===5?'feather':'umber',
      `WingTip${suffix}`,[side*(.442+j*.013),1.452-j*.041,.113-j*.044],[1,1,1],[7,side*(-11+j*17),side*(-2+j*.8)]);
    // Full feathered thighs conceal the upper tarsus; the planted feet have a
    // broad three-digit fan and visible knuckle bends rather than thin sticks.
    ellipsoid(`feathered_thigh_${suffix}`,'umber','Root',[side*.190,.491,.018],[.116,.245,.133],[0,0,side*9],16);
    for(let j=0;j<3;j++)append(`thigh_plume_${suffix}_${j}`,feather(.285-j*.025,.057,.011,side*.012,.012),'umber','Root',
      [side*(.142+j*.049),.624-j*.021,.137-j*.020],[1,1,1],[4,side*(-16+j*18),side*(-9+j*7)]);
    append(`tarsus_${suffix}`,sweepVolume([[side*.190,.352,.010],[side*.185,.232,.031],[side*.201,.127,.074],[side*.218,.079,.112]],
      [.043,.034,.041,.050],[.044,.035,.035,.033],12,8),'gold','Root');
    for (let j=0;j<3;j++) {
      const spread=(j-1)*.101,x=side*.218,reach=j===1?.344:.282;
      append(`articulated_toe_${suffix}_${j}`,sweepVolume([[x+(j-1)*.019,.082,.091],[x+spread*.58,.075,.168],
        [x+spread,.067,reach-.049],[x+spread*1.16,.037,reach]], [.028,.033,.029,.013],[.024,.027,.024,.012],12,8),'gold','Root');
      ellipsoid(`toe_knuckle_${suffix}_${j}`,'gold','Root',[x+spread,.071,reach-.049],[.030,.023,.030],[0,0,0],12);
      append(`curved_talon_${suffix}_${j}`,sweepVolume([[x+spread*1.16,.041,reach-.012],[x+spread*1.22,.045,reach+.032],
        [x+spread*1.26,.020,reach+.064]], [.016,.013,.0008],[.016,.011,.0008],8,6),'deep','Root');
    }
    append(`rear_digit_${suffix}`,sweepVolume([[side*.216,.079,.081],[side*.251,.060,-.002],[side*.269,.039,-.099]],
      [.028,.026,.013],[.025,.021,.011],10,8),'gold','Root');
    append(`rear_talon_${suffix}`,sweepVolume([[side*.269,.043,-.089],[side*.281,.043,-.130],[side*.285,.021,-.154]],
      [.014,.010,.0008],[.013,.009,.0008],8,6),'deep','Root');
    for(let j=0;j<3;j++) ellipsoid(`tarsal_scute_${suffix}_${j}`,'beakLight','Root',[side*(.201-j*.006),.139+j*.043,.105-j*.020],[.030,.011,.005],[0,0,0],10);
  }
  for (let j=0;j<7;j++) append(`layered_tail_${j}`,feather(.54-Math.abs(j-3)*.024,.054,.017,(j-3)*.009,.027),j%3===0?'umber':'deep','Tail',[(j-3)*.044,.715,-.232],[1,1,1],[34,0,(j-3)*5]);
  const merged = geometry(p,indices);
  merged.setAttribute('normal',new THREE.Float32BufferAttribute(n,3));
  merged.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  merged.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(joints,4));
  merged.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));
  const material = new THREE.MeshStandardMaterial({vertexColors:true,roughness:.86,metalness:0,side:THREE.DoubleSide});
  material.name = 'ATLAS_ROUGH_matte_vertex_palette';
  const mesh = new THREE.SkinnedMesh(merged,material); mesh.name = 'ATLAS_ROUGH_skinned_mesh';
  // The bounded prototype does not use stale rest-pose bounds for clip culling.
  mesh.frustumCulled = false; root.add(mesh); root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones)); mesh.normalizeSkinWeights();
  const rests = new Map(bones.map((bone)=>[bone.name,{position:bone.position.clone(),quaternion:bone.quaternion.clone()}]));
  root.userData = {status:'UNREVIEWED_SOURCE_REVISION',creativeRevision:config.creativeRevision,sourceExpectedSha256:config.sourceExpectedSha256,parts,coordinateConvention:config.coordinates,proceduralSeed:0,randomness:'none'};
  function reset() { for(const bone of bones){bone.position.copy(rests.get(bone.name).position);bone.quaternion.copy(rests.get(bone.name).quaternion);} root.updateMatrixWorld(true); }
  function pose(name) { reset(); const definition=config.poses[name]; if(!definition) throw Error('Unknown static pose.'); for(const [name,angles] of Object.entries(definition)) byName.get(name).quaternion.copy(quaternion(angles)); root.updateMatrixWorld(true); }
  function clip(name, duration, keys) {
    const tracks=[];
    // Explicit rest channels keep interrupts independent of previous clips.
    for(const bone of bones) {
      const values=[];
      for(const key of keys) values.push(...quaternion(key.pose[bone.name] || [0,0,0]).toArray());
      tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`,keys.map(k=>k.time),values));
    }
    return new THREE.AnimationClip(name,duration,tracks);
  }
  const stateClips = Object.entries(config.statePerformances).map(([name,performance]) => {
    if(!Object.hasOwn(config.poses,name))throw Error('A state performance requires its exact static fallback.');
    return clip(name,performance.duration,performance.keys.map(key=>({time:key.time,pose:key.state?config.poses[key.state]:key.pose})));
  });
  const clips = [...stateClips,
    // Retained inspection aliases keep rough-01 export/benchmark inputs valid.
    // They are never mapped from runtime success, text availability or idle.
    clip('rest',.04,[{time:0,pose:{}},{time:.04,pose:{}}]),
    clip('quick_reaction',.90,[{time:0,pose:{}},{time:.08,pose:{Head:[4,-3,2]}},{time:.34,pose:{Head:[-6,18,-5],Jaw:[10,0,0],BrowLeft:[0,0,9],BrowRight:[0,0,-9],WingLeft:[0,0,-10],WingRight:[0,0,10]}},{time:.48,pose:{Head:[-4,13,-3],BrowLeft:[0,0,7],BrowRight:[0,0,-7]}},{time:.90,pose:{}}]),
    clip('speech_test',1.6,Array.from({length:17},(_,i)=>({time:i/10,pose:{Jaw:[i===16?0:[0,13,5,19,0,9,16,3][i%8],0,0],Head:[i===16?0:Math.sin(i*.5)*1.5,0,0]}}))),
    clip('satisfied_nod',.90,[{time:0,pose:{}},{time:.08,pose:{Head:[-3,0,0]}},{time:.34,pose:{Head:[8,0,0],WingLeft:[0,0,-6],WingRight:[0,0,6]}},{time:.48,pose:{Head:[5,0,0]}},{time:.90,pose:{}}]),
  ];
  return {root,mesh,bones,clips,reset,pose,stats:{vertices:p.length/3,triangles:indices.length/3,bones:bones.length,materials:1,textures:0,parts:parts.length}};
}
