import {createPlaybackGate, STATE_NAMES, CLIP_NAMES, validateSequence, sequenceIndex} from './lifecycle.mjs';

const query = new URLSearchParams(location.search);
const mode = ['procedural','glb','poster','sequence'].includes(query.get('mode')) ? query.get('mode') : 'procedural';
const size = query.get('size') === '36' ? 36 : 256;
const dpr = query.get('dpr') === '2' ? 2 : 1;
const theme = query.get('theme') === 'dark' ? 'dark' : 'light';
// Export-only context option. Ordinary comparison modes keep their original
// opaque context; a transparent capture must never fake alpha by compositing.
const captureAlpha = query.get('captureAlpha') === '1';
const background = theme === 'dark' ? '#292c29' : '#fffefa';
const stage = document.querySelector('#stage');
const status = document.querySelector('#status');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const gate = createPlaybackGate({visible: !document.hidden, reduced: reduced.matches, character: query.get('hidden') !== '1'});
const started = performance.now();
const samples = {schemaVersion:1, status:'loading', mode,size,dpr,theme, rough:true, frameCount:0, cpuSubmitMs:[], frameWorkMs:[], rafIntervalsMs:[], interactionPaintMs:[], phases:{}, geometry:null, renderer:null, decodedRgbaEstimateBytes:null, actualGpuBytes:null, error:null};
let generation = 0, aborter = null, renderer = null, scene = null, camera = null, model = null, mixer = null, THREE = null;
let frames = [], sequence = null, sequenceCanvas = null, sequenceContext = null, animationFrame = null, clipStart = null, lastFrame = null;
let config = null, disposed = false, currentState = 'available', loopRunning = false, counter = 0;
let readyPromise = Promise.resolve(false);
const objectUrls = new Set();
const rests = new Map();
const phase = (name, start) => { samples.phases[name] = performance.now() - start; };
const writeStatus = (message) => { status.textContent = message; };
const fallback = () => { const node=document.createElement('div'); node.id='fallback'; node.textContent='A'; stage.replaceChildren(node); };
const current = (token) => !disposed && generation === token && gate.snapshot().character;
const boundedPush = (list,value) => { if(list.length < 2048) list.push(value); };
document.documentElement.dataset.theme = theme;
stage.style.width = `${size}px`; stage.style.height = `${size}px`;
for (const [id,value] of Object.entries({mode,size,dpr,theme})) document.getElementById(id).value = String(value);
document.getElementById('hide-character').checked = !gate.snapshot().character;

function stopLoop() {
  renderer?.setAnimationLoop(null);
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  animationFrame = null; loopRunning = false; lastFrame = null; clipStart = null;
  mixer?.stopAllAction(); gate.cancel();
}
function modelResources(root) {
  const geometries=new Set(), materials=new Set(), textures=new Set(), skeletons=new Set();
  root.traverse(node=>{
    if(node.geometry)geometries.add(node.geometry);
    if(node.material)for(const value of(Array.isArray(node.material)?node.material:[node.material]))materials.add(value);
    if(node.skeleton)skeletons.add(node.skeleton);
  });
  for(const material of materials)for(const value of Object.values(material))if(value?.isTexture)textures.add(value);
  return {geometries,materials,textures,skeletons};
}
function disposeModel(root) {
  const {geometries,materials,textures,skeletons}=modelResources(root), bitmaps=new Set();
  for(const texture of textures)for(const image of(Array.isArray(texture.image)?texture.image:[texture.image]))if(typeof image?.close==='function')bitmaps.add(image);
  for(const value of geometries)value.dispose();
  for(const value of textures)value.dispose();
  for(const value of materials)value.dispose();
  for(const value of skeletons)value.dispose();
  for(const value of bitmaps)value.close();
}
function disposeResources() {
  stopLoop(); aborter?.abort(); aborter = null;
  if (model) {
    mixer?.stopAllAction(); mixer?.uncacheRoot(model.root);
    disposeModel(model.root);
  }
  const previousRenderer=renderer;renderer=null;previousRenderer?.dispose();previousRenderer?.forceContextLoss();model=null;scene=null;camera=null;mixer=null;rests.clear();
  for(const url of objectUrls)URL.revokeObjectURL(url); objectUrls.clear(); frames=[]; sequence=null; sequenceCanvas=null; sequenceContext=null;
  fallback();
}
function render() {
  if(!renderer || disposed || !gate.snapshot().character || !gate.snapshot().visible || !gate.snapshot().onscreen) return;
  const start=performance.now(); renderer.render(scene,camera);
  const duration=performance.now()-start;boundedPush(samples.cpuSubmitMs,duration);samples.frameCount++;
  if(!Object.hasOwn(samples.phases,'firstDrawSubmitMs'))samples.phases.firstDrawSubmitMs=duration;
  samples.renderer={...samples.renderer,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures};
}
function setupCamera(framing='portrait',view='front',pixelSize=size,ratio=dpr) {
  if(!config.cameras[framing] || !Object.hasOwn(config.cameras.angles,view) || ![36,72,108,256,512].includes(pixelSize) || ![1,2].includes(ratio)) throw Error('Unsupported capture parameters.');
  const definition=config.cameras[framing], half=definition.height/2;
  camera.left=-half; camera.right=half; camera.top=half; camera.bottom=-half;
  const angle=config.cameras.angles[view]*Math.PI/180;
  camera.position.set(Math.sin(angle)*8,definition.target[1],Math.cos(angle)*8);
  camera.lookAt(...definition.target); camera.updateProjectionMatrix(); renderer.setPixelRatio(ratio); renderer.setSize(pixelSize,pixelSize,false);
}
function resetBones() {
  if(!model)return;
  for(const [bone,rest] of rests){bone.quaternion.copy(rest.quaternion);bone.position.copy(rest.position);bone.scale.copy(rest.scale);}
  model.root.updateMatrixWorld(true);
}
function staticBones(name) {
  resetBones();if(!model)return;
  for(const [boneName,degrees] of Object.entries(config.poses[name])){const bone=model.root.getObjectByName(boneName);if(!bone?.isBone)throw Error('Missing rig bone.');bone.quaternion.setFromEuler(new THREE.Euler(...degrees.map(v=>v*Math.PI/180)));}
  model.root.updateMatrixWorld(true);
}
function applyPose(name) {
  if(!STATE_NAMES.includes(name)) throw Error('Unknown state sample.');
  currentState=name; document.querySelector('#state-label').textContent=`State sample: ${name}`; document.querySelector('#pose').value=name;
  stopLoop();staticBones(name);render();
  if(mode==='sequence' && frames[0])drawSequence(0);
  if(samples.status==='ready')writeStatus(mode==='poster'||mode==='sequence' ? 'Generated rest image shown. This delivery has no separate static state poses.' : `Static ${name} pose shown. No live work is represented.`);
  return samples.status==='ready';
}
function sampleClip(name,time) {
  if(!model || !CLIP_NAMES.includes(name) || !Number.isFinite(time))throw Error('Valid loaded model and clip required.');
  const clip=model.clips.find(value=>value.name===name); if(!clip || time<0 || time>clip.duration+0.00001)throw Error('Clip sample is outside its bounded timeline.');
  mixer.stopAllAction(); resetBones(); const action=mixer.clipAction(clip); action.reset().setLoop(THREE.LoopOnce,1); action.clampWhenFinished=true; action.play(); mixer.setTime(time); model.root.updateMatrixWorld(true);
}
function drawSequence(index) {
  if(!sequenceContext || !frames[index] || disposed || !gate.snapshot().character || !gate.snapshot().visible || !gate.snapshot().onscreen)return;
  const start=performance.now(); sequenceContext.clearRect(0,0,sequenceCanvas.width,sequenceCanvas.height);sequenceContext.drawImage(frames[index],0,0,sequenceCanvas.width,sequenceCanvas.height);
  const duration=performance.now()-start;boundedPush(samples.cpuSubmitMs,duration);samples.frameCount++;
  if(!Object.hasOwn(samples.phases,'firstDrawSubmitMs'))samples.phases.firstDrawSubmitMs=duration;
}
function play(name) {
  stopLoop();
  if(samples.status!=='ready'){writeStatus('Character delivery unavailable. The independent control remains usable.');return false;}
  if(mode==='poster' || (mode==='sequence' && name!=='quick_reaction')){writeStatus('This generated delivery does not contain that clip.');return false;}
  if(mode==='sequence' && frames.length!==sequence.frames.length){writeStatus('Reload this sequence configuration to load its motion frames.');return false;}
  const duration=mode==='sequence'?sequence.duration:model?.clips.find(value=>value.name===name)?.duration;
  const token=gate.begin(name,duration);
  if(!token){writeStatus('Motion is unavailable while reduced motion, hiding or offscreen state applies. Static presentation remains.');return false;}
  loopRunning=true; writeStatus(`Playing ${name} once. Simulated presentation only.`);
  const tick=(now)=>{
    if(!gate.isCurrent(token))return;
    if(clipStart===null)clipStart=now;
    if(lastFrame!==null)boundedPush(samples.rafIntervalsMs,now-lastFrame);lastFrame=now;
    const frameStart=performance.now(), seconds=Math.min(duration,(now-clipStart)/1000);
    if(mode==='sequence')drawSequence(sequenceIndex(sequence.frames,seconds));else{sampleClip(name,seconds);render();}
    boundedPush(samples.frameWorkMs,performance.now()-frameStart);
    if(seconds>=duration){gate.finish(token);stopLoop();writeStatus('Test clip ended. Presentation is still.');return;}
    if(mode==='sequence')animationFrame=requestAnimationFrame(tick);
  };
  if(mode==='sequence')animationFrame=requestAnimationFrame(tick);else renderer.setAnimationLoop(tick);
  return true;
}
async function fetchJson(path,signal){const response=await fetch(path,{signal});if(!response.ok)throw Error(`Required local file unavailable (${response.status}).`);return response.json();}
async function imageFile(path,signal) {
  const response=await fetch(path,{signal});if(!response.ok)throw Error(`Generated image unavailable (${response.status}).`);
  const blob=await response.blob();if(blob.type!=='image/webp')throw Error('Expected generated WebP image.');
  const url=URL.createObjectURL(blob);objectUrls.add(url);const image=new Image();image.src=url;await image.decode();return image;
}
async function load() {
  const token=++generation; disposeResources();
  samples.status='loading';samples.error=null;samples.phases={};samples.geometry=null;samples.renderer=null;samples.decodedRgbaEstimateBytes=null;
  if(disposed || !gate.snapshot().character){samples.status=disposed?'disposed':'hidden';writeStatus(disposed?'Renderer disposed. Controls remain available.':'Character hidden. Controls and status remain available.');return false;}
  aborter=new AbortController();const signal=aborter.signal;const loadStart=performance.now();
  try {
    config=await fetchJson('/source/model.json',signal); if(!current(token))return false;
    if(mode==='poster' || mode==='sequence') {
      const imageStart=performance.now();
      if(mode==='poster'){
        const image=await imageFile(`/output/portrait-${theme}.webp`,signal);if(!current(token))return false;
        image.alt='';frames=[image];stage.replaceChildren(image);samples.decodedRgbaEstimateBytes=image.naturalWidth*image.naturalHeight*4;
      }else{
        sequence=validateSequence(await fetchJson(`/output/sequence-${theme}/manifest.json`,signal));if(!current(token))return false;
        const selected=gate.snapshot().reduced?sequence.frames.slice(0,1):sequence.frames;
        const loaded=await Promise.all(selected.map(frame=>imageFile(`/output/sequence-${theme}/${frame.file}`,signal)));if(!current(token))return false;
        if(loaded.some(image=>image.naturalWidth!==sequence.width||image.naturalHeight!==sequence.height))throw Error('Sequence frame dimensions do not match its manifest.');
        frames=loaded;sequenceCanvas=document.createElement('canvas');sequenceCanvas.width=size*dpr;sequenceCanvas.height=size*dpr;sequenceContext=sequenceCanvas.getContext('2d');if(!sequenceContext)throw Error('2D canvas unavailable.');stage.replaceChildren(sequenceCanvas);drawSequence(0);samples.decodedRgbaEstimateBytes=loaded.length*sequence.width*sequence.height*4;
      }
      phase('imagesDecodeMs',imageStart);
    }else{
      const importStart=performance.now();THREE=await import('three');if(!current(token))return false;phase('threeImportMs',importStart);
      scene=new THREE.Scene();scene.background=new THREE.Color(background);
      scene.add(new THREE.HemisphereLight(0xfff4de,0x383b45,2.1));const key=new THREE.DirectionalLight(0xffffff,3.0);key.position.set(-3,5,5);scene.add(key);const fill=new THREE.DirectionalLight(0xe1e8ff,1.2);fill.position.set(3,2,-2);scene.add(fill);
      const modelStart=performance.now();
      if(mode==='procedural'){
        const {createAtlas}=await import('/source/atlas-model.mjs');if(!current(token))return false;model=createAtlas(config);
      }else{
        const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');if(!current(token))return false;
        const response=await fetch('/output/atlas-rough.glb',{signal});if(!response.ok)throw Error(`Exported GLB unavailable (${response.status}).`);
        const bytes=await response.arrayBuffer();if(!current(token))return false;
        const gltf=await new GLTFLoader().parseAsync(bytes,'/output/');
        if(!current(token)){disposeModel(gltf.scene);return false;}
        model={root:gltf.scene,clips:gltf.animations};
        if(!CLIP_NAMES.every(name=>model.clips.some(clip=>clip.name===name)))throw Error('GLB is missing the authored rough clips.');
      }
      phase('modelBuildOrParseMs',modelStart);
      let vertices=0,triangles=0,bones=0;model.root.traverse(node=>{if(node.isBone){bones++;rests.set(node,{position:node.position.clone(),quaternion:node.quaternion.clone(),scale:node.scale.clone()});}if(node.isMesh){node.frustumCulled=false;vertices+=node.geometry.attributes.position.count;triangles+=(node.geometry.index?.count??node.geometry.attributes.position.count)/3;}});
      if(bones!==config.rig.length || vertices===0)throw Error('Unexpected model rig or empty geometry.');
      const resources=modelResources(model.root);
      if(mode==='glb') {
        const [material]=resources.materials, texture=material?.map, image=texture?.image;
        const width=image?.naturalWidth??image?.width, height=image?.naturalHeight??image?.height;
        if(resources.materials.size!==1||resources.textures.size!==1||!texture?.isTexture||width!==512||height!==512)
          throw Error('GLB color map did not load: expected one material and one decoded 512x512 texture.');
      }
      samples.geometry={vertices,triangles,bones,materials:resources.materials.size,textures:resources.textures.size};scene.add(model.root);mixer=new THREE.AnimationMixer(model.root);
      renderer=new THREE.WebGLRenderer({antialias:true,alpha:captureAlpha,preserveDrawingBuffer:true,powerPreference:'low-power'});renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1;
      const ownedRenderer=renderer;
      ownedRenderer.domElement.addEventListener('webglcontextlost',()=>{
        if(!current(token)||renderer!==ownedRenderer)return;
        ++generation;disposeResources();samples.status='failed';samples.error='WebGL context lost. Reload the configuration to retry.';writeStatus(`${samples.error} Status and controls remain usable.`);
      },{once:true});
      camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,30);setupCamera();stage.replaceChildren(renderer.domElement);
      const context=renderer.getContext(), debug=context.getExtension('WEBGL_debug_renderer_info');
      samples.renderer={webgl:context.getParameter(context.VERSION),vendor:debug?context.getParameter(debug.UNMASKED_VENDOR_WEBGL):null,device:debug?context.getParameter(debug.UNMASKED_RENDERER_WEBGL):null,preserveDrawingBuffer:true,alpha:context.getContextAttributes()?.alpha===true};
      const compileStart=performance.now();await renderer.compileAsync(scene,camera);if(!current(token))return false;phase('compileAsyncMs',compileStart);render();
    }
    if(!current(token))return false;
    samples.status='ready';phase('deliveryReadyMs',loadStart);samples.phases.navigationToReadyMs=performance.now()-started;
    writeStatus(mode==='procedural'?'Editable procedural model ready for rough inspection.':mode==='glb'?'Exported rough GLB loaded. Fidelity and performance are not certified.':'Generated raster delivery loaded. This is a render of the rough model.');return true;
  } catch(error) {
    if(!current(token))return false;
    disposeResources();samples.status='failed';samples.error=error instanceof Error?error.message:'Local delivery failed.';writeStatus(`${samples.error} Status and controls remain usable.`);return false;
  }
}
function interrupt(){stopLoop();resetBones();render();if(mode==='sequence'&&frames[0])drawSequence(0);currentState='available';document.querySelector('#state-label').textContent='State sample: available';document.querySelector('#pose').value='available';if(samples.status==='ready')writeStatus('Interrupted immediately to rest.');}
function setCharacterVisible(visible){gate.update({character:Boolean(visible)});document.querySelector('#hide-character').checked=!visible;++generation;disposeResources();if(visible&&!disposed){readyPromise=load();return readyPromise;}samples.status=disposed?'disposed':'hidden';writeStatus(visible?'Renderer disposed. Reload configuration to re-create it.':'Character hidden. Status and controls remain available.');return Promise.resolve(false);}
function dispose(){if(disposed)return;disposed=true;++generation;gate.dispose();disposeResources();observer.disconnect();document.removeEventListener('visibilitychange',onVisibility);reduced.removeEventListener('change',onReduced);samples.status='disposed';writeStatus('Renderer disposed. Status and controls remain available.');}
function onVisibility(){gate.update({visible:!document.hidden});if(document.hidden)stopLoop();else if(samples.status==='ready'){staticBones(currentState);render();if(mode==='sequence'&&frames[0])drawSequence(0);}}
function onReduced(){gate.update({reduced:reduced.matches});if(reduced.matches){interrupt();writeStatus('System reduced motion is active. Static presentation only.');}else if(mode==='sequence'&&samples.status==='ready'&&frames.length===1){writeStatus('Motion is available after reloading this sequence configuration.');}document.querySelector('#motion-note').textContent=reduced.matches?'System reduced motion: static presentation. No automatic override.':'Idle is still. Clips play once and can be interrupted immediately.';}
const observer=new IntersectionObserver(entries=>{const entry=entries.find(value=>value.target===stage);if(!entry)return;gate.update({onscreen:entry.isIntersecting});if(!entry.isIntersecting)stopLoop();else if(samples.status==='ready'){staticBones(currentState);render();if(mode==='sequence'&&frames[0])drawSequence(0);}}, {threshold:0.01});observer.observe(stage);
document.addEventListener('visibilitychange',onVisibility);reduced.addEventListener('change',onReduced);window.addEventListener('pagehide',dispose,{once:true});
document.querySelector('#apply-pose').addEventListener('click',()=>applyPose(document.querySelector('#pose').value));
for(const button of document.querySelectorAll('[data-clip]'))button.addEventListener('click',()=>play(button.dataset.clip));
document.querySelector('#interrupt').addEventListener('click',interrupt);
document.querySelector('#hide-character').addEventListener('change',event=>void setCharacterVisible(!event.target.checked));document.querySelector('#dispose').addEventListener('click',dispose);
document.querySelector('#independent').addEventListener('click',()=>{const begin=performance.now();counter++;document.querySelector('#counter').textContent=String(counter);requestAnimationFrame(()=>requestAnimationFrame(()=>boundedPush(samples.interactionPaintMs,performance.now()-begin)));});
function metrics(){return {...samples,phases:{...samples.phases},cpuSubmitMs:[...samples.cpuSubmitMs],frameWorkMs:[...samples.frameWorkMs],rafIntervalsMs:[...samples.rafIntervalsMs],interactionPaintMs:[...samples.interactionPaintMs],gate:gate.snapshot(),loopRunning,currentState,counter,visibility:document.visibilityState,resourceEntries:performance.getEntriesByType('resource').map(entry=>({name:new URL(entry.name).pathname,initiatorType:entry.initiatorType,duration:entry.duration,transferSize:entry.transferSize,encodedBodySize:entry.encodedBodySize,decodedBodySize:entry.decodedBodySize})),evidenceLimits:{gpuExecutionTime:'unmeasured',actualGpuMemory:'unmeasured',native:'unmeasured',battery:'unmeasured',thermal:'unmeasured',fieldINP:'unmeasured',deployedBundle:'unmeasured'}};}
document.querySelector('#show-metrics').addEventListener('click',()=>document.querySelector('#metrics').textContent=JSON.stringify(metrics(),null,2));
window.atlas={
  get ready(){return readyPromise;},metrics,applyPose,play,interrupt,dispose,setCharacterVisible,
  async capture({pose='available',view='front',framing='portrait',size:pixelSize=256,dpr:ratio=1,clip=null,time=0,format='image/png',transparent=false}={}){
    if(!(await readyPromise)||!model||disposed)throw Error('A loaded model is required for export.');
    if(!['image/png','image/webp'].includes(format))throw Error('Unsupported capture format.');
    if(typeof transparent!=='boolean'||(transparent&&!renderer.getContext().getContextAttributes()?.alpha))throw Error('Transparent capture requires an alpha-enabled export context.');
    if(!STATE_NAMES.includes(pose))throw Error('Unknown static capture pose.');
    if(!gate.snapshot().visible||!gate.snapshot().onscreen||!gate.snapshot().character)throw Error('Visible character required for capture.');
    const previous={camera:camera.clone(),size:renderer.getSize(new THREE.Vector2()),ratio:renderer.getPixelRatio(),
      viewport:renderer.getViewport(new THREE.Vector4()),scissor:renderer.getScissor(new THREE.Vector4()),scissorTest:renderer.getScissorTest(),
      background:scene.background,color:renderer.getClearColor(new THREE.Color()),alpha:renderer.getClearAlpha(),
      bones:[...rests.keys()].map(bone=>({bone,position:bone.position.clone(),quaternion:bone.quaternion.clone(),scale:bone.scale.clone()}))};
    stopLoop();
    try{
      setupCamera(framing,view,pixelSize,ratio);
      if(transparent){scene.background=null;renderer.setClearColor(0x000000,0);}
      if(clip)sampleClip(clip,time);else staticBones(pose);
      render();const data=renderer.domElement.toDataURL(format,.90);
      if(!data.startsWith(`data:${format};base64,`))throw Error('Requested image encoding unavailable.');
      return data;
    }finally{
      mixer.stopAllAction();scene.background=previous.background;renderer.setClearColor(previous.color,previous.alpha);
      camera.copy(previous.camera);camera.updateProjectionMatrix();renderer.setPixelRatio(previous.ratio);renderer.setSize(previous.size.x,previous.size.y,false);
      renderer.setViewport(previous.viewport);renderer.setScissor(previous.scissor);renderer.setScissorTest(previous.scissorTest);
      for(const {bone,position,quaternion,scale} of previous.bones){bone.position.copy(position);bone.quaternion.copy(quaternion);bone.scale.copy(scale);}
      model.root.updateMatrixWorld(true);render();
    }
  },
  async exportGLB(){
    if(!(await readyPromise)||mode!=='procedural'||!model||disposed)throw Error('Editable procedural model required.');
    stopLoop();resetBones();const {GLTFExporter}=await import('three/addons/exporters/GLTFExporter.js');
    const result=await new GLTFExporter().parseAsync(model.root,{binary:true,trs:true,animations:model.clips,onlyVisible:true});
    const bytes=new Uint8Array(result);let binary='';for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));return btoa(binary);
  },
};
onReduced();readyPromise=load();
