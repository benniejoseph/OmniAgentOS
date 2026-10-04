/** ATLAS sculpt 02 — editable procedural mesh, bind skeleton and authored clips.
 * No raster planes, generated imagery, physics, audio, providers or app imports.
 * Geometry is deterministic; Three UUIDs are internal and not provenance IDs.
 */
import * as THREE from 'three';

const DEG = Math.PI / 180;
const clamp = (n) => Math.min(1, Math.max(0, n));
const quaternion = (degrees) => new THREE.Quaternion().setFromEuler(new THREE.Euler(...degrees.map((v) => v * DEG)));

function geometry(positions, indices) {
  const value = new THREE.BufferGeometry();
  value.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  value.setIndex(indices);
  value.computeVertexNormals();
  return value;
}

/** Elliptical horizontal sections, capped; profile rows: Y, radiusX, radiusZ, centerZ. */
function loft(profile, segments) {
  const positions = [], indices = [];
  for (const [y, rx, rz, cz = 0] of profile) {
    for (let n = 0; n < segments; n++) {
      const angle = n * 2 * Math.PI / segments;
      positions.push(rx * Math.cos(angle), y, cz + rz * Math.sin(angle));
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

/** Curved, scalloped front throat patch. It is geometry, not a texture cutout. */
function throat(profile) {
  const positions = [], indices = [], across = 12;
  for (const [y, width, z] of profile) {
    for (let n = 0; n <= across; n++) {
      const t = n / across * 2 - 1;
      positions.push(t * width, y - (n % 2 ? 0.009 : 0), z - t * t * 0.055);
    }
  }
  for (let row = 0; row < profile.length - 1; row++) {
    for (let n = 0; n < across; n++) {
      const a = row * (across + 1) + n, b = a + 1, d = a + across + 1, c = d + 1;
      indices.push(a, b, d, b, c, d);
    }
  }
  return geometry(positions, indices);
}

/** Hooked upper mandible: non-circular sections ordered from face to tip. */
function upperBeak() {
  const sections = [[.245,2.635,.094,.070],[.302,2.625,.121,.094],[.392,2.60,.114,.111],[.477,2.558,.076,.10],[.531,2.505,.033,.064],[.548,2.456,.004,.012]];
  const positions = [], indices = [], sides = 12;
  for (const [z, y, rx, ry] of sections) {
    for (let n=0;n<sides;n++) {
      const angle=n*Math.PI*2/sides, vertical=Math.sin(angle);
      positions.push(rx*Math.cos(angle),y+ry*vertical*(vertical<0?.42:1),z);
    }
  }
  for (let row = 0; row < sections.length - 1; row++) {
    for (let n = 0; n < sides; n++) {
      const a = row * sides + n, b = row * sides + (n + 1) % sides;
      indices.push(a,b,a+sides, b,b+sides,a+sides);
    }
  }
  for(let n=1;n<sides-1;n++) {
    indices.push(0,n+1,n);
    const end=(sections.length-1)*sides;indices.push(end,end+n,end+n+1);
  }
  return geometry(positions, indices);
}

function mandible() {
  return geometry([-0.105,2.55,0.27, 0.105,2.55,0.27, 0.08,2.50,0.44, 0,2.47,0.51, -0.08,2.50,0.44, 0,2.46,0.33],
    [0,1,2,0,2,4,2,3,4,0,5,1,1,5,2,2,5,3,3,5,4,4,5,0]);
}

function feather(length = 1, width = 0.12, depth = 0.04, sweep = 0, curl = .015) {
  // Rounded overlapping vane, not a triangular spike. Thin convex cross-sections
  // catch the key light along a soft central ridge without lines or textures.
  const profile=[[0,.08],[.10,.62],[.28,1],[.49,.95],[.70,.75],[.87,.40],[.97,.11],[1,.006]];
  const positions=[],indices=[],segments=8;
  for(const [t,envelope] of profile) for(let n=0;n<segments;n++) {
    const a=n*2*Math.PI/segments,side=Math.cos(a),front=Math.sin(a);
    positions.push(sweep*t*t+width*envelope*side,-length*t,
      curl*t*t+depth*envelope*front*(front<0?.25:1));
  }
  for(let row=0;row<profile.length-1;row++) for(let n=0;n<segments;n++) {
    const a=row*segments+n,b=row*segments+(n+1)%segments;
    indices.push(a,b,a+segments,b,b+segments,a+segments);
  }
  for(let n=1;n<segments-1;n++) {
    indices.push(0,n+1,n);const end=(profile.length-1)*segments;indices.push(end,end+n,end+n+1);
  }
  return geometry(positions,indices);
}

function orbitalRim(profile, start = 0, arc = Math.PI*2) {
  const positions=[],indices=[],segments=28;
  for(const [radius,z] of profile) for(let n=0;n<=segments;n++) {
    const a=start+n/segments*arc;
    positions.push(.104*radius*Math.cos(a),.080*radius*Math.sin(a),z);
  }
  for(let row=0;row<profile.length-1;row++) for(let n=0;n<segments;n++) {
    const a=row*(segments+1)+n,b=a+1,c=b+segments+1,d=a+segments+1;
    indices.push(a,d,b,b,d,c);
  }
  return geometry(positions,indices);
}

function upperLid() {
  const positions=[],indices=[],around=20,rows=6;
  // An upper, front cap; the eye remains behind its rim. A weighted upper edge
  // anchors to the head while the lower edge follows the independent lid bone.
  for(let row=0;row<=rows;row++) for(let n=0;n<=around;n++) {
    const theta=.06+row/rows*1.20,phi=n/around*Math.PI;
    positions.push(.098*Math.sin(theta)*Math.cos(phi),.078*Math.cos(theta),.047*Math.sin(theta)*Math.sin(phi));
  }
  for(let row=0;row<rows;row++) for(let n=0;n<around;n++) {
    const a=row*(around+1)+n,b=a+1,d=a+around+1,c=d+1;indices.push(a,b,d,b,c,d);
  }
  return geometry(positions,indices);
}

function browVane(side) {
  const positions=[],indices=[],rows=12;
  for(let n=0;n<=rows;n++) {
    const t=n/rows, x=side*(-.116+t*.255), arch=Math.sin(Math.PI*t);
    // The inner end no longer forms a permanent angry V. The brow has a quiet
    // convex arch, a broad inner root, and one swept, tapered outer tip.
    const half=.013+.020*Math.sin(Math.PI*(.12+t*.86));
    for(let cross=0;cross<3;cross++) positions.push(x,.008+arch*.017+(cross-1)*half,
      .013+arch*.023+(cross===1?.010:0)-t*t*.024);
  }
  for(let row=0;row<rows;row++) for(let cross=0;cross<2;cross++) {
    const a=row*3+cross,b=a+1,d=a+3,c=d+1;
    indices.push(...(side>0?[a,d,b,b,d,c]:[a,b,d,b,c,d]));
  }
  return geometry(positions,indices);
}

function profileAt(profile, y) {
  const upper=profile.findIndex(row=>row[0]>=y);
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
  const spineWeight = (y) => {
    if (y < 0.65) return [['Root', 1]];
    if (y < 1.75) return [['Spine', 1]];
    const neck = clamp((y - 1.75) / 0.45), head = clamp((y - 2.34) / 0.24);
    return head > 0 ? [['Neck',1-head],['Head',head]] : [['Spine',1-neck],['Neck',neck]];
  };
  function append(name, mesh, shade, bone, position = [0,0,0], scale = [1,1,1], rotation = [0,0,0]) {
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(...position), quaternion(rotation), new THREE.Vector3(...scale));
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix), offset = p.length / 3;
    const vertices = mesh.getAttribute('position'), normals = mesh.getAttribute('normal');
    color.set(config.palette[shade]);
    for (let i = 0; i < vertices.count; i++) {
      point.fromBufferAttribute(vertices, i).applyMatrix4(matrix);
      normal.fromBufferAttribute(normals, i).applyMatrix3(normalMatrix).normalize();
      p.push(point.x,point.y,point.z); n.push(normal.x,normal.y,normal.z); colors.push(color.r,color.g,color.b);
      const influences = typeof bone === 'function' ? bone(point.y) : [[bone,1]];
      for (let slot = 0; slot < 4; slot++) { joints.push(influences[slot] ? boneIndex.get(influences[slot][0]) : 0); weights.push(influences[slot]?.[1] || 0); }
    }
    for (let i = 0; i < mesh.index.count; i++) indices.push(offset + mesh.index.getX(i));
    parts.push({name,vertexStart:offset,vertexCount:vertices.count}); mesh.dispose();
  }
  const ellipsoid = (name, shade, bone, position, scale, rotation = [0,0,0], segments = 16) =>
    append(name, new THREE.SphereGeometry(1,segments,10), shade,bone,position,scale,rotation);
  append('tapered_torso_and_neck',loft(config.bodyProfile,config.radialSegments),'umber',spineWeight);
  append('head_silhouette',loft(config.headProfile,config.radialSegments),'umber','Head');
  append('pale_throat',throat(config.throatProfile),'throat',spineWeight);
  // A constant slim band follows the lower neck. Throat feathers continue
  // underneath it; the collar is not a seam that cuts the neck into cylinders.
  append('charcoal_collar',loft([[1.998,.234,.225,0],[2.013,.233,.226,0],[2.048,.224,.218,0],[2.056,.221,.214,0]],36),'collar','Neck');
  append('collar_upper_stitch',loft([[2.045,.225,.219,0],[2.054,.223,.217,0]],36),'collarEdge','Neck');
  append('collar_tab',geometry([-.10,2.015,.238,-.031,2.008,.244,-.059,1.945,.249,-.125,1.912,.236], [0,1,2,0,2,3]),'collar','Neck');
  // Breast coverts overlap downward and become narrower toward the tapered belly.
  // Deterministic row offsets avoid both a tiled checkerboard and random noise.
  for(let row=0;row<7;row++) {
    const y=1.78-row*.17,[,rx,rz,cz]=profileAt(config.bodyProfile,y);
    const count=row<4?14:12;
    for(let j=0;j<count;j++) {
      const a=2*Math.PI*(j+(row%2)*.5)/count;
      append(`body_covert_${row}_${j}`,feather(.235-row*.007,.063-row*.002,.011,Math.sin(a)*.012,.009),
        (j+row*2)%7===0?'feather':'umber',spineWeight,
        [rx*Math.sin(a)*1.008,y,cz+rz*Math.cos(a)*1.008],[1,1,1],[0,a/DEG,0]);
    }
  }
  // Short throat barbs retain a continuous pale field and scalloped edges.
  for(let row=0;row<5;row++) {
    const y=2.61-row*.135,[,width,z]=profileAt(config.throatProfile,y);
    const count=row<3?7:5;
    for(let j=0;j<count;j++) {
      const t=(j/(count-1)*2-1)*.83;
      append(`throat_barb_${row}_${j}`,feather(.205,.031,.007,t*.019,.004),j%3===1?'throatLight':'throat',spineWeight,
        [t*width,y,z-t*t*.055+.006],[1,1,1],[0,0,-t*9]);
    }
  }
  append('upper_hooked_beak',upperBeak(),'beakLight','Head');
  append('lower_beak',mandible(),'gold','Jaw');
  for (const side of [-1,1]) {
    const suffix = side === 1 ? 'Left' : 'Right';
    const eye=[side*.162,2.753,.222];
    append(`orbital_plane_${suffix}`,orbitalRim([[.87,.040],[1.03,.045],[1.23,.020],[1.48,-.022]]),'umber','Head',eye);
    append(`recessed_socket_${suffix}`,orbitalRim([[.76,.036],[.87,.047],[.97,.044]]),'deep','Head',eye);
    ellipsoid(`eye_white_${suffix}`,'eyeWhite','Head',eye,[.089,.073,.036],[0,side*-3,0],24);
    ellipsoid(`iris_${suffix}`,'iris','Head',[side*.151,2.750,.260],[.034,.041,.006],[0,0,0],20);
    ellipsoid(`pupil_${suffix}`,'pupil','Head',[side*.151,2.750,.266],[.016,.023,.003],[0,0,0],16);
    ellipsoid(`eye_highlight_${suffix}`,'eyeWhite','Head',[side*.144,2.765,.270],[.006,.007,.002],[0,0,0],12);
    const lidWeight=y=>{const head=clamp((y-2.79)/.038);return [['Head',head],[`UpperLid${suffix}`,1-head]];};
    append(`upper_lid_${suffix}`,upperLid(),'umber',lidWeight,eye);
    append(`lower_lid_${suffix}`,orbitalRim([[.86,.040],[.96,.045],[1.12,.034]],Math.PI,Math.PI),'feather','Head',eye);
    append(`neutral_brow_${suffix}`,browVane(side),'deep',`Brow${suffix}`,[side*.16,2.821,.231]);
    for(let j=0;j<3;j++) append(`brow_covert_${suffix}_${j}`,feather(.115,.031,.012,side*.036,.008),j===1?'featherLight':'feather',`Brow${suffix}`,
      [side*(.112+j*.047),2.868-j*.008,.237-j*.008],[1,1,1],[15,side*18,side*65]);
    for(let j=0;j<4;j++) append(`swept_crown_${suffix}_${j}`,feather(.19+j*.018,.045,.016,side*.025,.014),j%2?'umber':'feather','Head',
      [side*(.105+j*.049),3.016-j*.018,-.033-j*.012],[1,1,1],[76,side*5,side*(16+j*4)]);
    for(let j=0;j<4;j++) append(`cheek_covert_${suffix}_${j}`,feather(.21-j*.015,.052,.013,side*.016,.009),'umber','Head',
      [side*(.283-j*.004),2.755-j*.068,.010-j*.023],[1,1,1],[30,side*42,side*12]);
    ellipsoid(`nostril_${suffix}`,'beakShadow','Head',[side*.075,2.650,.326],[.012,.006,.006],[0,side*25,side*8],12);
    // Shoulder is an under-form. Shingled scapular and covert rows cover it;
    // long primaries nest under those rows and overlap toward the tapered tail.
    ellipsoid(`wing_underform_${suffix}`,'deep',`Wing${suffix}`,[side*.397,1.38,-.045],[.128,.355,.154],[0,0,side*6],20);
    for(let row=0;row<3;row++) for(let j=0;j<4;j++) append(`wing_covert_${suffix}_${row}_${j}`,
      feather(.31+row*.04,.057-row*.004,.016,side*.025,.018),(row+j)%4===0?'feather':'umber',`Wing${suffix}`,
      [side*(.36+j*.037),1.71-row*.145-j*.035,.088-j*.055+row*.010],[1,1,1],[9,side*(-8+j*22),side*(2+j*3)]);
    for(let j=0;j<8;j++) append(`wing_primary_${suffix}_${j}`,feather(.66-j*.022,.057,.017,side*.018,.027),j%4===0?'feather':'umber',
      `WingTip${suffix}`,[side*(.39+j*.017),1.34-j*.047,.106-j*.039],[1,1,1],[6,side*(-12+j*17),side*(1+j*1.5)]);
    ellipsoid(`leg_${suffix}`,'gold','Root',[side*.16,.215,.01],[.047,.18,.043],[0,0,0],12);
    for (let j=0;j<3;j++) {
      ellipsoid(`toe_${suffix}_${j}`,'gold','Root',[side*.16+(j-1)*.060,.065,.11],[.026,.029,.15],[0,(j-1)*14,0],12);
      append(`claw_${suffix}_${j}`,feather(.063,.017,.012),'deep','Root',[side*.16+(j-1)*.082,.067,.24],[1,1,1],[-85,0,0]);
    }
  }
  for (let j=0;j<7;j++) append(`tail_feather_${j}`,feather(.57-Math.abs(j-3)*.025,.055,.013,(j-3)*.009,.022),j%3===0?'umber':'deep','Tail',[(j-3)*.046,.72,-.225],[1,1,1],[30,0,(j-3)*6]);
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
