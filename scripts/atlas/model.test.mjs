import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Color,Ray,Vector3,SRGBColorSpace,LinearFilter,ClampToEdgeWrapping} from 'three';
import {createAtlas} from '../../.design/asael-ace-revamp/atlas-production/source/atlas-model.mjs';
import {STATE_NAMES,CLIP_NAMES,createPlaybackGate,validateSequence,sequenceIndex} from '../../.design/asael-ace-revamp/atlas-production/web/lifecycle.mjs';
const config=JSON.parse(await readFile(new URL('../../.design/asael-ace-revamp/atlas-production/source/model.json',import.meta.url),'utf8'));
const release = model => {model.mesh.geometry.dispose();model.mesh.material.map?.dispose();model.mesh.material.dispose();model.mesh.skeleton.dispose();};
const wingAtlasPartNames=new Set();
for(const side of ['Left','Right']) {
  wingAtlasPartNames.add(`folded_wing_underform_${side}`);
  for(let row=0;row<3;row++)for(let column=0;column<4;column++)wingAtlasPartNames.add(`layered_wing_covert_${side}_${row}_${column}`);
  for(let index=0;index<8;index++)wingAtlasPartNames.add(`curved_primary_${side}_${index}`);
}

test('procedural geometry is finite, indexed and deterministically bound to the 14-bone eyelid rig',()=>{
  const a=createAtlas(config),b=createAtlas(config);
  try{
    assert.equal(a.bones.length,14);assert.equal(new Set(a.bones.map(bone=>bone.name)).size,14);
    for(const name of ['position','normal','color','uv','skinIndex','skinWeight']){
      const values=a.mesh.geometry.getAttribute(name).array;
      assert.ok(Array.from(values).every(Number.isFinite),name);
      assert.deepEqual(values,b.mesh.geometry.getAttribute(name).array,name);
    }
    const geometry=a.mesh.geometry,skin=geometry.getAttribute('skinIndex'),weights=geometry.getAttribute('skinWeight');
    assert.ok(a.stats.triangles>0 && a.stats.triangles<50000,'rough prototype bound, not a production budget');
    assert.ok(Array.from(geometry.index.array).every(index=>index>=0 && index<geometry.attributes.position.count));
    for(let vertex=0;vertex<skin.count;vertex++){
      let sum=0;for(let slot=0;slot<4;slot++){const index=skin.array[vertex*4+slot],weight=weights.array[vertex*4+slot];assert.ok(index>=0 && index<14);assert.ok(weight>=0&&weight<=1);sum+=weight;}
      assert.ok(Math.abs(sum-1)<0.00001);
    }
    for(const definition of config.rig)if(definition.parent)assert.equal(a.bones.find(bone=>bone.name===definition.name).parent.name,definition.parent);
    assert.equal(a.root.userData.sourceExpectedSha256,config.sourceExpectedSha256);assert.equal(a.stats.textures,1);
    const map=a.mesh.material.map;
    assert.ok(map.isDataTexture);assert.equal(map.image.width,1024);assert.equal(map.image.height,1024);
    assert.equal(map.image.data.byteLength,4194304);assert.deepEqual(map.image.data,b.mesh.material.map.image.data);
    // Public retained feather-02 image digest, full-width RGBA rows 480–1023.
    const retainedUpperSha256='2ffac06903676fb1451b46e492ba17ba4d8b8d49f7fc955ad98e4d958c99d0e4'; // gitleaks:allow -- public image digest
    const upperBytes=map.image.data.subarray(480*1024*4);
    assert.equal(upperBytes.byteLength,2228224);
    assert.equal(createHash('sha256').update(upperBytes).digest('hex'),retainedUpperSha256,
      'torso paint must preserve the entire retained head/throat chart, upper gutters and white patch');
    assert.equal(map.colorSpace,SRGBColorSpace);assert.equal(map.flipY,false);assert.equal(map.generateMipmaps,false);
    assert.equal(map.minFilter,LinearFilter);assert.equal(map.magFilter,LinearFilter);
    assert.equal(map.wrapS,ClampToEdgeWrapping);assert.equal(map.wrapT,ClampToEdgeWrapping);
    assert.equal(geometry.getAttribute('uv').count,geometry.getAttribute('position').count);
    assert.ok(Array.from(geometry.getAttribute('uv').array).every(value=>value>=0&&value<=1));
    for(let i=3;i<map.image.data.length;i+=4)assert.equal(map.image.data[i],255,'opaque color map');
    // Probe chart data and triangle interiors: UV interpolation must not pull
    // the front throat's pale field onto the upper head, seam or rear.
    const continuous=a.root.userData.parts.filter(part=>['continuous_eagle_silhouette','continuous_directional_plumage'].includes(part.name));
    assert.equal(continuous.length,2);
    const position=geometry.getAttribute('position'),uv=geometry.getAttribute('uv');
    const profile=[...config.bodyProfile.filter(row=>row[0]<config.headProfile[0][0]),...config.headProfile];
    const radiusXAt=y=>{
      const next=profile.findIndex(row=>row[0]>=y);
      if(next<0)return profile.at(-1)[1];
      if(next===0)return profile[0][1];
      const a=profile[next-1],b=profile[next],t=(y-a[0])/(b[0]-a[0]);
      return a[1]+(b[1]-a[1])*t;
    };
    const umber=Number.parseInt(config.palette.umber.slice(1),16),base=[(umber>>16)&255,(umber>>8)&255,umber&255];
    const pixel=(x,y)=>map.image.data.subarray((y*1024+x)*4,(y*1024+x)*4+4);
    const filteredPixel=(u,v)=>{
      const x=u*1024-.5,y=v*1024-.5,left=Math.floor(x),bottom=Math.floor(y),dx=x-left,dy=y-bottom;
      return [0,1,2].map(channel=>pixel(left,bottom)[channel]*(1-dx)*(1-dy)+pixel(left+1,bottom)[channel]*dx*(1-dy)
        +pixel(left,bottom+1)[channel]*(1-dx)*dy+pixel(left+1,bottom+1)[channel]*dx*dy);
    };
    const bytes=color=>color.toArray().map(value=>Math.round(value*255));
    const lower=bytes(new Color(config.palette.umber).multiplyScalar(.76).convertLinearToSRGB());
    const upper=bytes(new Color(config.palette.umber).multiplyScalar(1.22).convertLinearToSRGB());
    const headLower=bytes(new Color(config.palette.umber).multiplyScalar(.80).convertLinearToSRGB());
    const headUpper=bytes(new Color(config.palette.umber).multiplyScalar(1.17).convertLinearToSRGB());
    const paleLower=bytes(new Color(config.palette.throat).multiplyScalar(.83).convertLinearToSRGB());
    const paleUpper=bytes(new Color(config.palette.throat).multiplyScalar(1.10).convertLinearToSRGB());
    let darker=0,lighter=0,junctionVariation=0,upperVariation=0,palePixels=0;
    for(let y=16;y<=480;y++)for(let x=16;x<496;x++) {
      const front=pixel(x,y),rear=pixel(x+512,y);
      assert.deepEqual(front,rear,'front and rear body fields must share exact bytes');
      for(let channel=0;channel<3;channel++)assert.ok(front[channel]>=lower[channel]&&front[channel]<=upper[channel],
        'body feathers must stay inside the encoded 0.76–1.22 linear-color bound');
      if(front[0]<base[0])darker++;if(front[0]>base[0])lighter++;
      if(y===480&&front[0]!==base[0])junctionVariation++;
    }
    assert.ok(darker>1000&&lighter>1000,'the body must contain nonconstant feather marks on both sides of base umber');
    assert.ok(junctionVariation>20,'the shared Y=2.08 row must retain feather detail instead of a plain dividing stripe');
    for(let y=481;y<960;y++)for(let x=16;x<496;x++) {
      const restY=2.08+.995*(y-480)/479;
      const restX=radiusXAt(restY)*Math.sin(-Math.PI/2+Math.PI*(x-16)/479);
      const front=pixel(x,y),rear=pixel(x+512,y),isHead=restY>=2.74;
      for(let channel=0;channel<3;channel++) {
        assert.ok(rear[channel]>=(isHead?headLower:lower)[channel]&&rear[channel]<=(isHead?headUpper:upper)[channel],
          'rear feathers must retain bounded umber without pale throat color');
        assert.ok(front[channel]>=lower[channel]&&front[channel]<=paleUpper[channel],'front color must stay inside its umber/pale envelope');
      }
      if(restY<2.095||restY>2.765||Math.abs(restX)>=.36)
        assert.deepEqual(front,rear,'pale color must stay inside the existing front-throat region');
      if(restY>2.78&&rear[0]!==base[0])upperVariation++;
      if(front[0]>upper[0])palePixels++;
    }
    assert.ok(upperVariation>1000,'the upper head must contain a finite feather field above the former clamp');
    assert.ok(palePixels>1000,'the front throat must retain its pale color region');
    // These central samples are inside the full pale mask, away from its edge.
    for(const restY of [2.38,2.46,2.54])for(const restX of [-.06,0,.06]) {
      const angle=Math.asin(restX/radiusXAt(restY));
      const sample=pixel(Math.round(16+479*(.5+angle/Math.PI)),Math.round(480+479*(restY-2.08)/.995));
      for(let channel=0;channel<3;channel++)assert.ok(sample[channel]>=paleLower[channel]&&sample[channel]<=paleUpper[channel],
        'interior pale feathers must respect the 0.83–1.10 linear-color limits');
    }
    // Modulation fades at actual chart edges. Check the entire linear filter
    // footprint, including adjacent umber gutters and the separate white sample.
    for(const left of [16,528]) {
      for(let edge=0;edge<480;edge++)for(const y of [15,16,959,960])
        assert.deepEqual(Array.from(pixel(left+edge,y)),[...base,255],'horizontal chart padding must remain umber');
      for(let y=16;y<960;y++)for(const x of [left-1,left,left+479,left+480])
        assert.deepEqual(Array.from(pixel(x,y)),[...base,255],'vertical chart padding must remain umber');
    }
    for(let y=992;y<1024;y++)for(let x=992;x<1024;x++)
      assert.deepEqual(Array.from(pixel(x,y)),[255,255,255,255],'the separate white patch must include the constant UV footprint');
    const tufts=a.root.userData.parts.filter(part=>/^(breast|mantle)_flow_tuft_/.test(part.name));
    assert.equal(tufts.length,44);
    const colors=geometry.getAttribute('color');
    for(const part of tufts) {
      let meanZ=0;for(let i=part.vertexStart;i<part.vertexStart+part.vertexCount;i++)meanZ+=position.getZ(i);
      const left=meanZ<=0?528:16;
      for(let i=part.vertexStart;i<part.vertexStart+part.vertexCount;i++) {
        const column=uv.getX(i)*1024-.5;
        assert.ok(column>=left-.0001&&column<=left+479+.0001,`${part.name} must occupy one complete atlas island`);
        assert.equal(colors.getX(i),colors.getY(i));assert.equal(colors.getX(i),colors.getZ(i));
        assert.ok(colors.getX(i)>=.97&&colors.getX(i)<=1.02,'tufts must retain a scalar tone, with umber supplied by the atlas');
      }
    }
    const brows=a.root.userData.parts.filter(part=>/^neutral_brow_sweep_(Left|Right)$/.test(part.name));
    assert.equal(brows.length,2);
    for(const part of brows)for(let i=part.vertexStart;i<part.vertexStart+part.vertexCount;i++) {
      const column=uv.getX(i)*1024-.5,row=uv.getY(i)*1024-.5;
      assert.ok(column>=16&&column<=495&&row>480&&row<959,'only the front upper chart may color a fitted brow');
      assert.equal(colors.getX(i),colors.getY(i));assert.equal(colors.getX(i),colors.getZ(i));
    }
    const wings=a.root.userData.parts.filter(part=>wingAtlasPartNames.has(part.name));
    assert.equal(wings.length,42);
    assert.deepEqual(new Set(wings.map(part=>part.name)),wingAtlasPartNames,'only the two underforms, 24 coverts and 16 named primaries join the mapped parts');
    const unchanged=a.root.userData.parts.filter(part=>!continuous.includes(part)&&!tufts.includes(part)&&!brows.includes(part)&&!wings.includes(part));
    assert.equal(unchanged.length,77);
    for(const part of unchanged)for(let i=part.vertexStart;i<part.vertexStart+part.vertexCount;i++) {
      assert.equal(uv.getX(i),504/512);assert.equal(uv.getY(i),504/512);
    }
    // Equal authored radial steps must have equal chart spacing at both the
    // broad torso and the squared face. A planar X projection compresses the
    // samples near each side and fails this check; ignoring the face contour
    // inversion also fails the head ring while leaving the torso ring intact.
    const silhouette=continuous.find(part=>part.name==='continuous_eagle_silhouette');
    for(const y of [1.40,2.78]) {
      let start=-1;
      for(let i=silhouette.vertexStart;i<silhouette.vertexStart+silhouette.vertexCount;i++)
        if(Math.abs(position.getY(i)-y)<.000001){start=i;break;}
      assert.ok(start>=0,`the authored Y=${y} silhouette ring must exist`);
      for(let radial=0;radial<config.radialSegments;radial++) {
        const i=start+radial,column=uv.getX(i)*1024-.5,left=uv.getX(i)<.5?16:528;
        const expected=479*Math.abs(1-2*radial/config.radialSegments);
        assert.ok(Math.abs(column-left-expected)<.001,
          `Y=${y} radial sample ${radial} must preserve uniform angular chart spacing`);
      }
    }
    const headRows=new Set();let headMin=Infinity,headMax=-Infinity,seamPairs=0;
    for(const part of continuous) {
      const seam=new Map();
      for(let i=part.vertexStart;i<part.vertexStart+part.vertexCount;i++) {
        if(position.getY(i)>2.76) {
          const row=uv.getY(i)*1024-.5;
          headRows.add(Math.round(row));headMin=Math.min(headMin,row);headMax=Math.max(headMax,row);
          assert.ok(row<959,'the silhouette top must fit below the chart clamp');
        }
        const key=[position.getX(i),position.getY(i),position.getZ(i)].join(',');
        const previous=seam.get(key);
        if(previous!==undefined&&(uv.getX(previous)<.5)!==(uv.getX(i)<.5)) {
          assert.ok(Math.abs(Math.abs(uv.getX(previous)-uv.getX(i))*1024-512)<.0001,'front/rear copies need matching X coordinates');
          assert.equal(uv.getY(previous),uv.getY(i),'front/rear copies need matching Y coordinates');
          const first=filteredPixel(uv.getX(previous),uv.getY(previous)),second=filteredPixel(uv.getX(i),uv.getY(i));
          assert.ok(first.every((value,channel)=>Math.abs(value-second[channel])<.001),
            'seam copies must have matching pale-free filter footprints, allowing only Float32 UV roundoff');
          seamPairs++;
        }else seam.set(key,i);
      }
    }
    assert.ok(headRows.size>=5&&headMax-headMin>120,'upper-head UVs must cover the expanded chart rather than repeat one row');
    assert.ok(seamPairs>=300,'both continuous layers must retain their front/rear seam copies');
    const probes=[[1/3,1/3,1/3],[.75,.125,.125],[.125,.75,.125],[.125,.125,.75]];
    let upperHeadTriangles=0,rearTriangles=0,rearGrainSamples=0,upperGrainSamples=0;const sampledParts=new Set();
    for(let offset=0;offset<geometry.index.count;offset+=3){
      const triangle=[geometry.index.getX(offset),geometry.index.getX(offset+1),geometry.index.getX(offset+2)];
      const part=continuous.find(value=>triangle.every(index=>index>=value.vertexStart&&index<value.vertexStart+value.vertexCount));
      if(!part)continue;
      assert.ok(triangle.every(index=>uv.getX(index)<.5)||triangle.every(index=>uv.getX(index)>.5),
        'every continuous triangle must occupy one atlas island');
      const upperHead=triangle.every(index=>position.getY(index)>2.78),rear=triangle.every(index=>position.getZ(index)<=0);
      if(!upperHead&&!rear)continue;
      if(upperHead)upperHeadTriangles++;if(rear)rearTriangles++;sampledParts.add(part.name);
      for(const barycentric of probes){
        const u=triangle.reduce((sum,index,corner)=>sum+uv.getX(index)*barycentric[corner],0);
        const v=triangle.reduce((sum,index,corner)=>sum+uv.getY(index)*barycentric[corner],0);
        const x=Math.max(0,Math.min(map.image.width-1,Math.floor(u*map.image.width)));
        const y=Math.max(0,Math.min(map.image.height-1,Math.floor(v*map.image.height)));
        const texel=(y*map.image.width+x)*4;
        if(rear&&map.image.data[texel]!==base[0])rearGrainSamples++;
        if(upperHead&&map.image.data[texel]!==base[0])upperGrainSamples++;
        if(rear)assert.ok(x>=528&&x<1008,'rear triangles must stay in the rear island');
        for(let channel=0;channel<3;channel++)assert.ok(
          map.image.data[texel+channel]>=(upperHead?headLower:lower)[channel]&&map.image.data[texel+channel]<=(upperHead?headUpper:upper)[channel],
          `${part.name} triangle ${offset/3} must exclude pale color and keep its feather field bounded`);
      }
    }
    assert.ok(upperHeadTriangles>0&&rearTriangles>0,'both excluded pale-field regions must be sampled');
    assert.ok(rearGrainSamples>0,'rear body interiors must actually sample the bounded grain field');
    assert.ok(upperGrainSamples>0,'upper-head interiors must actually sample their expanded feather field');
    assert.equal(sampledParts.size,2,'both continuous layers must contribute interior samples');
  }finally{release(a);release(b);}
});

test('mapped wing surfaces use bounded brown paint with scalar tones and continuous longitudinal seams',()=>{
  const model=createAtlas(config);try{
    const geometry=model.mesh.geometry,position=geometry.getAttribute('position'),uv=geometry.getAttribute('uv'),colors=geometry.getAttribute('color');
    const image=model.mesh.material.map.image;
    const wings=model.root.userData.parts.filter(part=>wingAtlasPartNames.has(part.name));
    assert.equal(wings.length,42);assert.deepEqual(new Set(wings.map(part=>part.name)),wingAtlasPartNames);
    const bytes=color=>color.toArray().map(value=>Math.round(value*255));
    const lower=bytes(new Color(config.palette.umber).multiplyScalar(.76).convertLinearToSRGB());
    const upper=bytes(new Color(config.palette.umber).multiplyScalar(1.22).convertLinearToSRGB());
    const vertexOwners=new Map(),samples=new Map();
    const filteredPixel=(u,v)=>{
      const x=u*image.width-.5,y=v*image.height-.5,left=Math.floor(x),bottom=Math.floor(y),dx=x-left,dy=y-bottom;
      assert.ok(left>=528&&left+1<=1007&&bottom>=16&&bottom+1<=480,
        'the complete wing filter footprint must stay inside existing brown rear-body texels');
      const pixel=(column,row,channel)=>image.data[(row*image.width+column)*4+channel];
      return [0,1,2].map(channel=>pixel(left,bottom,channel)*(1-dx)*(1-dy)+pixel(left+1,bottom,channel)*dx*(1-dy)
        +pixel(left,bottom+1,channel)*(1-dx)*dy+pixel(left+1,bottom+1,channel)*dx*dy);
    };
    for(const part of wings) {
      let minimumTone=Infinity,maximumTone=-Infinity;
      samples.set(part.name,{triangles:0,colors:new Set(),minimumRed:Infinity,maximumRed:-Infinity});
      for(let index=part.vertexStart;index<part.vertexStart+part.vertexCount;index++) {
        vertexOwners.set(index,part);
        const u=uv.getX(index),v=uv.getY(index),tone=colors.getX(index);
        assert.ok(Number.isFinite(u)&&Number.isFinite(v));
        assert.ok(u>=544.5/1024-1e-7&&u<=991.5/1024+1e-7&&v>=48.5/1024-1e-7&&v<=447.5/1024+1e-7,
          `${part.name}: every corner and affine triangle interior must stay in the retained brown rectangle`);
        assert.equal(colors.getY(index),tone);assert.equal(colors.getZ(index),tone);
        assert.ok(Number.isFinite(tone)&&tone>=.95-1e-6&&tone<=1.03+1e-6,
          `${part.name}: umber comes from the atlas once, with only bounded scalar vertex tones`);
        minimumTone=Math.min(minimumTone,tone);maximumTone=Math.max(maximumTone,tone);
        if(part.name.startsWith('folded_wing_underform_'))assert.equal(tone,1,'underforms retain their unit tone');
      }
      if(part.name.startsWith('layered_wing_covert_')||part.name.startsWith('curved_primary_'))assert.ok(minimumTone<.97&&maximumTone>1.005,
        `${part.name}: the original crest/root tonal variation must not be flattened to a constant`);
      if(part.name.startsWith('curved_primary_')) {
        assert.equal(part.vertexCount,64,'the retained primary vane has eight closed rings of eight vertices');
        for(let row=0;row<8;row++)for(let column=0;column<8;column++) {
          const index=part.vertexStart+row*8+column,next=part.vertexStart+row*8+(column+1)%8;
          assert.ok(Math.abs(uv.getX(index)-uv.getX(next))*1024<11,'every primary ring edge, including closure, avoids a chart-wrap jump');
          assert.equal(uv.getY(index),uv.getY(next),'each primary ring follows one longitudinal texture level');
          const mirror=part.vertexStart+row*8+(8-column)%8;
          assert.ok(Math.abs(uv.getX(index)-uv.getX(mirror))*1024<.001,'front/rear primary surfaces share lateral paint coordinates');
          if(row<7)assert.ok(uv.getY(index)>uv.getY(index+8),'primary paint progresses root to tip without reversal');
        }
        const span=(uv.getY(part.vertexStart)-uv.getY(part.vertexStart+56))*1024;
        assert.ok(span>160&&span<180,'each primary uses a longitudinal paint strip instead of repeating a single row');
      }
    }
    const probes=[[1/3,1/3,1/3],[.6,.2,.2],[.2,.6,.2],[.2,.2,.6]];
    for(let offset=0;offset<geometry.index.count;offset+=3) {
      const triangle=[0,1,2].map(corner=>geometry.index.getX(offset+corner));
      const part=vertexOwners.get(triangle[0]);if(!part)continue;
      assert.ok(triangle.every(index=>vertexOwners.get(index)===part),'a wing triangle must remain inside its own named part');
      const measured=samples.get(part.name);measured.triangles++;
      for(const barycentric of probes) {
        const u=triangle.reduce((sum,index,corner)=>sum+uv.getX(index)*barycentric[corner],0);
        const v=triangle.reduce((sum,index,corner)=>sum+uv.getY(index)*barycentric[corner],0);
        const sample=filteredPixel(u,v);
        for(let channel=0;channel<3;channel++)assert.ok(sample[channel]>=lower[channel]-1e-5&&sample[channel]<=upper[channel]+1e-5,
          `${part.name}: triangle-interior paint must exclude pale/white texels and remain in the retained umber range`);
        measured.colors.add(sample.map(Math.round).join(','));
        measured.minimumRed=Math.min(measured.minimumRed,sample[0]);measured.maximumRed=Math.max(measured.maximumRed,sample[0]);
      }
    }
    for(const [name,measured] of samples) {
      assert.ok(measured.triangles>0,`${name}: actual indexed triangles must contribute samples`);
      assert.ok(measured.colors.size>=3&&measured.maximumRed-measured.minimumRed>1,
        `${name}: interior samples must show nonconstant paint, not a collapsed UV or one flat texel`);
    }
    let seamPairs=0;
    for(const part of wings.filter(value=>value.name.startsWith('folded_wing_underform_'))) {
      assert.equal(part.vertexCount,21*11,'the retained 20-by-10 underform grid and duplicate seam vertices remain');
      // Non-pole copies on the sphere's longitudinal seam occupy the same
      // surface point. Compare UVs and complete filtered paint, not just names.
      for(let row=1;row<10;row++) {
        const first=part.vertexStart+row*21,last=first+20;
        const a=new Vector3().fromBufferAttribute(position,first),b=new Vector3().fromBufferAttribute(position,last);
        assert.ok(a.distanceTo(b)<1e-6,'longitudinal seam samples must be physically coincident');
        assert.ok(Math.abs(uv.getX(first)-uv.getX(last))*1024<.001&&Math.abs(uv.getY(first)-uv.getY(last))*1024<.001,
          'coincident wing seam copies must meet at the same chart location');
        const startColor=filteredPixel(uv.getX(first),uv.getY(first)),endColor=filteredPixel(uv.getX(last),uv.getY(last));
        assert.ok(startColor.every((value,channel)=>Math.abs(value-endColor[channel])<.001),'wing seam copies must have matching filtered paint');
        const columns=[];
        for(let column=0;column<=20;column++) {
          const index=first+column;columns.push(uv.getX(index)*1024);
          if(column>0)assert.ok(Math.abs(uv.getX(index)-uv.getX(index-1))*1024<50,
            'an adjacent wing ring edge must not jump across the atlas chart');
        }
        assert.ok(Math.max(...columns)-Math.min(...columns)>400,'each wing ring must use the angular chart rather than collapse onto one strip');
        seamPairs++;
      }
    }
    assert.equal(seamPairs,18,'both underforms must contribute all nine non-pole longitudinal seam pairs');
  }finally{release(model);}
});

test('all eight state samples reset to the same rest transform without accumulating pose changes',()=>{
  const model=createAtlas(config);try{
    assert.deepEqual(Object.keys(config.poses),STATE_NAMES);
    const rest=model.bones.map(bone=>bone.matrixWorld.toArray());
    for(const state of STATE_NAMES){model.pose(state);model.reset();assert.deepEqual(model.bones.map(bone=>bone.matrixWorld.toArray()),rest);}
    assert.throws(()=>model.pose('unknown'));
  }finally{release(model);}
});

test('authored clips are finite one-shot timelines with a rest channel for every bone',()=>{
  const model=createAtlas(config);try{
    assert.deepEqual(model.clips.map(clip=>clip.name),CLIP_NAMES);
    for(const clip of model.clips){
      assert.ok(clip.duration>0 && clip.duration<=2);assert.equal(clip.tracks.length,14);
      for(const track of clip.tracks){assert.equal(track.times[0],0);assert.ok(Math.abs(track.times.at(-1)-clip.duration)<.000001);assert.ok(Array.from(track.values).every(Number.isFinite));for(let i=1;i<track.times.length;i++)assert.ok(track.times[i]>track.times[i-1]);}
    }
    assert.deepEqual(Array.from(model.clips.find(clip=>clip.name==='quick_reaction').tracks[0].times).map(t=>Math.round(t*1000)),[0,80,340,480,900]);
  }finally{release(model);}
});

test('each exact companion clip settles to its matching static reduced-motion pose',()=>{
  const model=createAtlas(config);try{
    assert.deepEqual(Object.keys(config.statePerformances),STATE_NAMES);
    for(const state of STATE_NAMES){
      const clip=model.clips.find(value=>value.name===state);assert.ok(clip);
      model.pose(state);
      for(const bone of model.bones){
        const track=clip.tracks.find(value=>value.name===`${bone.name}.quaternion`);
        const actual=Array.from(track.values.slice(-4)),expected=bone.quaternion.toArray();
        assert.ok(actual.every((value,index)=>Math.abs(value-expected[index])<.000001),`${state}/${bone.name}`);
      }
    }
  }finally{release(model);}
});

test('independent eyelids move while the recessed iris stays head-bound',()=>{
  const model=createAtlas(config);try{
    const lid=model.root.userData.parts.find(part=>part.name==='soft_upper_lid_Left');
    const iris=model.root.userData.parts.find(part=>part.name==='iris_Left').vertexStart;
    assert.ok(lid,'the independent upper lid must be present');
    const position=model.mesh.geometry.attributes.position,skin=model.mesh.geometry.attributes.skinIndex,weights=model.mesh.geometry.attributes.skinWeight;
    const lidBone=model.bones.findIndex(bone=>bone.name==='UpperLidLeft');
    const eyeX=config.rig.find(bone=>bone.name==='UpperLidLeft').position[0];
    // Probe the front of the mobile central rim, not an old tessellation offset.
    const rim=Array.from({length:lid.vertexCount},(_,index)=>lid.vertexStart+index).filter(index=>{
      let influence=0;for(let slot=0;slot<4;slot++)if(skin.array[index*4+slot]===lidBone)influence+=weights.array[index*4+slot];
      return influence>.9&&Math.abs(position.getX(index)-eyeX)<.015;
    }).sort((a,b)=>position.getZ(b)-position.getZ(a));
    assert.ok(rim.length>0,'the central rim must be independently lid-bound');
    const lowerEdge=rim[0];
    const at=index=>model.mesh.applyBoneTransform(index,new Vector3().fromBufferAttribute(model.mesh.geometry.attributes.position,index));
    const beforeLid=at(lowerEdge),beforeIris=at(iris);
    model.bones.find(bone=>bone.name==='UpperLidLeft').rotation.x=Math.PI/3;model.root.updateMatrixWorld(true);
    assert.ok(at(lowerEdge).distanceTo(beforeLid)>.015);assert.ok(at(iris).distanceTo(beforeIris)<.000001);
    model.reset();assert.ok(at(lowerEdge).distanceTo(beforeLid)<.000001);
  }finally{release(model);}
});

test('brow attachment borders follow the head while the central ridge retains its authored raise',()=>{
  const model=createAtlas(config);try{
    const geometry=model.mesh.geometry,position=geometry.getAttribute('position');
    const skin=geometry.getAttribute('skinIndex'),weights=geometry.getAttribute('skinWeight');
    const head=model.root.userData.parts.find(part=>part.name==='continuous_eagle_silhouette');
    const headBone=model.bones.findIndex(bone=>bone.name==='Head'),triangles=[];
    for(let offset=0;offset<geometry.index.count;offset+=3) {
      const indices=[0,1,2].map(corner=>geometry.index.getX(offset+corner));
      if(!indices.every(index=>index>=head.vertexStart&&index<head.vertexStart+head.vertexCount))continue;
      const points=indices.map(index=>new Vector3().fromBufferAttribute(position,index));
      if(Math.max(...points.map(point=>point.y))>=2.74&&Math.min(...points.map(point=>point.y))<=2.92)triangles.push(points);
    }
    const influence=(index,bone)=>{
      let total=0;for(let slot=0;slot<4;slot++)if(skin.array[index*4+slot]===bone)total+=weights.array[index*4+slot];
      return total;
    };
    const at=index=>model.mesh.applyBoneTransform(index,new Vector3().fromBufferAttribute(position,index));
    const ray=new Ray(new Vector3(),new Vector3(0,0,-1)),hit=new Vector3(),attached=[],centers=[];
    for(const suffix of ['Left','Right']) {
      const part=model.root.userData.parts.find(part=>part.name===`neutral_brow_sweep_${suffix}`);
      const browBone=model.bones.findIndex(bone=>bone.name===`Brow${suffix}`);
      assert.equal(part.vertexCount,17*8,'retained brow topology');
      const mobile=[];
      for(let local=0;local<part.vertexCount;local++) {
        const index=part.vertexStart+local,row=Math.floor(local/8),column=local%8;
        const border=row===0||row===16||(column>=2&&column<=6);
        if(border) {
          assert.equal(influence(index,headBone),1,'terminal and attachment borders must be fully Head-bound');
          ray.origin.set(position.getX(index),position.getY(index),1);
          let surfaceZ=-Infinity;
          for(const [a,b,c] of triangles)if(ray.intersectTriangle(a,b,c,false,hit))surfaceZ=Math.max(surfaceZ,hit.z);
          assert.ok(Number.isFinite(surfaceZ),'each border must intersect an actual retained head triangle');
          const gap=position.getZ(index)-surfaceZ;
          assert.ok(gap>=-.0041&&gap<=-.0017,'attachment borders must sit just inside the actual mesh');
          attached.push(index);
        }
        if(influence(index,browBone)>.99)mobile.push(index);
      }
      assert.ok(mobile.length>=4,'the central ridge must retain independently mobile Brow vertices');
      centers.push({suffix,indices:mobile});
    }
    const peak=config.statePerformances.needs_you.keys.find(key=>key.time===.34).pose;
    model.bones[headBone].rotation.set(...peak.Head.map(value=>value*Math.PI/180));
    model.root.updateMatrixWorld(true);
    const before=new Map([...attached,...centers.flatMap(group=>group.indices)].map(index=>[index,at(index)]));
    for(const suffix of ['Left','Right'])model.bones.find(bone=>bone.name===`Brow${suffix}`)
      .rotation.set(...peak[`Brow${suffix}`].map(value=>value*Math.PI/180));
    model.root.updateMatrixWorld(true);
    for(const index of attached)assert.ok(at(index).distanceTo(before.get(index))<.000001,'a brow raise must not lift its attachment border');
    for(const {suffix,indices} of centers)assert.ok(Math.max(...indices.map(index=>at(index).distanceTo(before.get(index))))>.001,
      `${suffix} central ridge must retain independent movement under its existing needs_you key`);
  }finally{release(model);}
});

test('a jaw pose deforms its lower mandible while the head-bound upper beak stays in place',()=>{
  const model=createAtlas(config);try{
    const upper=model.root.userData.parts.find(part=>part.name==='upper_hooked_beak').vertexStart;
    const mandible=model.root.userData.parts.find(part=>part.name==='lower_beak');
    assert.ok(mandible,'the lower mandible must be present');
    // The forward tip is the semantic hinge probe across different ring counts.
    const position=model.mesh.geometry.attributes.position;
    const lower=Array.from({length:mandible.vertexCount},(_,index)=>mandible.vertexStart+index)
      .reduce((tip,index)=>position.getZ(index)>position.getZ(tip)?index:tip,mandible.vertexStart);
    const at=index=>model.mesh.applyBoneTransform(index,new Vector3().fromBufferAttribute(model.mesh.geometry.attributes.position,index));
    const beforeUpper=at(upper),beforeLower=at(lower);model.pose('responding');
    // Responding also tilts the head. Compare a jaw-closed equivalent to isolate the hinge.
    const jaw=model.bones.find(bone=>bone.name==='Jaw');const opened=jaw.quaternion.clone();jaw.quaternion.identity();model.root.updateMatrixWorld(true);
    const closedLower=at(lower),closedUpper=at(upper);jaw.quaternion.copy(opened);model.root.updateMatrixWorld(true);
    assert.ok(at(lower).distanceTo(closedLower)>.01);assert.ok(at(upper).distanceTo(closedUpper)<.000001);
    model.reset();assert.ok(at(upper).distanceTo(beforeUpper)<.000001);assert.ok(at(lower).distanceTo(beforeLower)<.000001);
  }finally{release(model);}
});

test('playback interruption rejects the old token immediately, including hide and re-show',()=>{
  const gate=createPlaybackGate(),first=gate.begin('quick_reaction',.9);assert.ok(gate.isCurrent(first));
  const next=gate.begin('listening',.42);assert.equal(gate.isCurrent(first),false);assert.ok(gate.isCurrent(next));
  gate.update({character:false});gate.update({character:true});assert.equal(gate.isCurrent(next),false);assert.equal(gate.snapshot().active,null);
  gate.finish(first);const fresh=gate.begin('rest',.04);assert.ok(gate.isCurrent(fresh));
  gate.finish(next);assert.ok(gate.isCurrent(fresh),'an old completion cannot stop a replacement clip');
});

test('OS reduction, visibility, offscreen state and disposal never resume a canceled clip',()=>{
  for(const field of ['reduced','visible','onscreen','character']){
    const gate=createPlaybackGate(),token=gate.begin('quick_reaction',.9);
    gate.update({[field]:field==='reduced'});assert.equal(gate.isCurrent(token),false);assert.equal(gate.begin('rest',.04),null);
    gate.update({[field]:field!=='reduced'});assert.equal(gate.snapshot().active,null);
  }
  const gate=createPlaybackGate();gate.dispose();assert.equal(gate.begin('listening',.42),null);assert.equal(gate.snapshot().disposed,true);
  assert.equal(createPlaybackGate().begin('unknown',.9),null);assert.equal(createPlaybackGate().begin('rest',Infinity),null);assert.equal(createPlaybackGate().begin('rest',3),null);
});

test('frame manifests are bounded, exact local identities with monotonic rest endpoints',()=>{
  const value={schemaVersion:1,clip:'quick_reaction',duration:.9,width:256,height:256,frames:[{time:0,file:'reaction-00.webp'},{time:.9,file:'reaction-01.webp'}]};
  const parsed=validateSequence(value);assert.equal(sequenceIndex(parsed.frames,.3),0);assert.equal(sequenceIndex(parsed.frames,.9),1);
  for(const bad of [{...value,frames:[...value.frames,...value.frames]},{...value,frames:[{time:0,file:'https://example.com/a.webp'},value.frames[1]]},{...value,duration:900},{...value,width:2048},{...value,frames:Array(33).fill(value.frames[0])}])assert.throws(()=>validateSequence(bad));
  assert.throws(()=>sequenceIndex(parsed.frames,NaN));
});
