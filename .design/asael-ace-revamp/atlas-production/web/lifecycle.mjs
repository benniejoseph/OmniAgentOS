/** Presentation-only gate. It never receives an application event or grants an effect. */
export const STATE_NAMES = Object.freeze(['available','listening','responding','working','needs_you','blocked','completed','paused']);
export const CLIP_NAMES = Object.freeze([...STATE_NAMES,'rest','quick_reaction','speech_test','satisfied_nod']);
export const MAX_SEQUENCE_FRAMES = 32;

export function createPlaybackGate(initial = {}) {
  let epoch = 0, active = null, disposed = false;
  let environment = { visible: true, onscreen: true, reduced: false, character: true, ...initial };
  const allowed = () => !disposed && environment.visible && environment.onscreen && !environment.reduced && environment.character;
  const cancel = () => { epoch++; active = null; };
  return {
    begin(clip, duration) {
      cancel();
      if (!CLIP_NAMES.includes(clip) || !Number.isFinite(duration) || duration <= 0 || duration > 2 || !allowed()) return null;
      active = Object.freeze({epoch,clip,duration}); return active;
    },
    isCurrent(token) { return token !== null && active === token && allowed(); },
    finish(token) { if (active === token) cancel(); },
    cancel,
    update(next) { environment = {...environment,...next}; if (!allowed()) cancel(); },
    dispose() { disposed = true; cancel(); },
    snapshot() { return {disposed, allowed:allowed(), active:active?.clip ?? null, epoch, ...environment}; },
  };
}

export function validateSequence(value) {
  if (!value || value.schemaVersion !== 1 || value.clip !== 'quick_reaction' || value.duration !== 0.9 ||
      value.width !== 256 || value.height !== 256 || !Array.isArray(value.frames) ||
      value.frames.length < 2 || value.frames.length > MAX_SEQUENCE_FRAMES) throw Error('Unsupported bounded frame sequence.');
  let previous = -1;
  const frames = value.frames.map((frame, index) => {
    if (!frame || !Number.isFinite(frame.time) || frame.time < 0 || frame.time > value.duration || frame.time <= previous ||
        frame.file !== `reaction-${String(index).padStart(2,'0')}.webp`) throw Error('Invalid frame identity or timeline.');
    previous = frame.time; return {time:frame.time,file:frame.file};
  });
  if (frames[0].time !== 0 || frames.at(-1).time !== value.duration) throw Error('Sequence must include rest endpoints.');
  return {duration:value.duration,width:value.width,height:value.height,frames};
}

export function sequenceIndex(frames, seconds) {
  if (!Number.isFinite(seconds)) throw Error('Finite sequence time required.');
  let index = 0;
  while (index + 1 < frames.length && frames[index + 1].time <= seconds) index++;
  return index;
}
