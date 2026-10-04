import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Vector3} from 'three';
import {createAtlas} from '../../.design/asael-ace-revamp/atlas-production/source/atlas-model.mjs';
import {STATE_NAMES,CLIP_NAMES,createPlaybackGate,validateSequence,sequenceIndex} from '../../.design/asael-ace-revamp/atlas-production/web/lifecycle.mjs';
const config=JSON.parse(await readFile(new URL('../../.design/asael-ace-revamp/atlas-production/source/model.json',import.meta.url),'utf8'));
const release = model => {model.mesh.geometry.dispose();model.mesh.material.dispose();model.mesh.skeleton.dispose();};

test('procedural geometry is finite, indexed and deterministically bound to the 14-bone eyelid rig',()=>{
  const a=createAtlas(config),b=createAtlas(config);
  try{
    assert.equal(a.bones.length,14);assert.equal(new Set(a.bones.map(bone=>bone.name)).size,14);
    for(const name of ['position','normal','color','skinIndex','skinWeight']){
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
    assert.equal(a.root.userData.sourceExpectedSha256,config.sourceExpectedSha256);assert.equal(a.stats.textures,0);
  }finally{release(a);release(b);}
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
