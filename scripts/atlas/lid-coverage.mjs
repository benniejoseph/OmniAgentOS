#!/usr/bin/env node
/**
 * Read-only, two-sided triangle-overlap diagnostics for authored ATLAS lids.
 * This does not determine visible pixels or certify a closed eye aperture.
 *
 * node scripts/atlas/lid-coverage.mjs --model /path/atlas-model.mjs \
 *   --config /path/model.json --output /path/diagnostics.json
 * Repeat --sample available:0.12 and --view 30 to override the defaults.
 */
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {AnimationMixer, LoopOnce, OrthographicCamera, Vector3} from 'three';

const DEFAULT_MODEL = new URL('../../.design/asael-ace-revamp/atlas-production/source/atlas-model.mjs', import.meta.url);
export const DEFAULT_SAMPLES = Object.freeze([
  {clip: 'available', time: 0},
  {clip: 'available', time: 0.06},
  {clip: 'available', time: 0.12},
  {clip: 'available', time: 0.18},
  {clip: 'needs_you', time: 0.34},
].map(Object.freeze));
export const DEFAULT_VIEWS = Object.freeze([0, -30, 30]);
const LINEAR_EPSILON = 1e-10;
const AREA_EPSILON = 1e-14;
const LID_PARTS = ['soft_upper_lid', 'upper_lid_seam'];
const EYE_PARTS = ['almond_eye', 'iris', 'pupil', 'eye_highlight'];
const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

function polygonArea(points) {
  if (points.length < 3) return 0;
  // Translating to the first vertex avoids cancellation at distant origins.
  let twiceArea = 0;
  for (let i = 1; i + 1 < points.length; i++) twiceArea += cross(points[0], points[i], points[i + 1]);
  return Math.abs(twiceArea) / 2;
}

function prepareTriangle(points) {
  if (points.length !== 3 || points.some(point => !['x', 'y', 'z'].every(axis => Number.isFinite(point[axis])))) {
    throw new TypeError('A projected triangle requires three finite {x, y, z} vertices.');
  }
  const determinant = cross(...points);
  return {
    points, determinant,
    degenerate: Math.abs(determinant) / 2 <= AREA_EPSILON,
    minX: Math.min(...points.map(point => point.x)), maxX: Math.max(...points.map(point => point.x)),
    minY: Math.min(...points.map(point => point.y)), maxY: Math.max(...points.map(point => point.y)),
  };
}

function removeDuplicateVertices(points) {
  const distinct = [];
  const apart = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) > LINEAR_EPSILON;
  for (const point of points) if (!distinct.length || apart(point, distinct.at(-1))) distinct.push(point);
  if (distinct.length > 1 && !apart(distinct[0], distinct.at(-1))) distinct.pop();
  return distinct;
}

function overlapPolygon(subject, clip) {
  let polygon = subject.points.map(({x, y}) => ({x, y}));
  const sign = Math.sign(clip.determinant);
  for (let edge = 0; edge < 3 && polygon.length; edge++) {
    const a = clip.points[edge], b = clip.points[(edge + 1) % 3];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const distance = point => {
      const value = sign * cross(a, b, point) / length;
      return Math.abs(value) <= LINEAR_EPSILON ? 0 : value;
    };
    const next = [];
    let previous = polygon.at(-1), previousDistance = distance(previous);
    for (const current of polygon) {
      const currentDistance = distance(current);
      if ((currentDistance >= 0) !== (previousDistance >= 0)) {
        const t = previousDistance / (previousDistance - currentDistance);
        next.push({x: previous.x + t * (current.x - previous.x), y: previous.y + t * (current.y - previous.y)});
      }
      if (currentDistance >= 0) next.push(current);
      previous = current;
      previousDistance = currentDistance;
    }
    polygon = removeDuplicateVertices(next);
  }
  return polygon;
}

function depthAt(triangle, point) {
  const [a, b, c] = triangle.points;
  const bWeight = cross(a, point, c) / triangle.determinant;
  const cWeight = cross(a, b, point) / triangle.determinant;
  const aWeight = 1 - bWeight - cWeight;
  return aWeight * a.z + bWeight * b.z + cWeight * c.z;
}

function boundsOverlap(a, b) {
  return a.minX <= b.maxX + LINEAR_EPSILON && b.minX <= a.maxX + LINEAR_EPSILON
    && a.minY <= b.maxY + LINEAR_EPSILON && b.minY <= a.maxY + LINEAR_EPSILON;
}

function comparePrepared(lid, eye) {
  if (lid.degenerate || eye.degenerate) return {status: 'degenerate-projection', probeCount: 0, minimumDepthGap: null};
  const polygon = boundsOverlap(lid, eye) ? overlapPolygon(lid, eye) : [];
  const area = polygonArea(polygon);
  if (area <= AREA_EPSILON) return {status: 'no-area-overlap', probeCount: 0, minimumDepthGap: null};
  const probes = polygon.map(point => {
    const lidDepth = depthAt(lid, point), eyeDepth = depthAt(eye, point);
    return {...point, lidDepth, eyeDepth, depthGap: lidDepth - eyeDepth};
  });
  const minimum = probes.reduce((a, b) => a.depthGap <= b.depthGap ? a : b);
  return {
    status: 'measured', overlapArea: area, probeCount: probes.length,
    minimumDepthGap: minimum.depthGap,
    maximumDepthGap: Math.max(...probes.map(probe => probe.depthGap)),
    minimum, probes,
  };
}

/**
 * Camera-space x/y are orthographic coordinates; larger camera z is nearer.
 * The difference of two planar triangle depths is affine over their convex
 * overlap, so its minimum occurs at an overlap vertex, including new edge
 * intersections. Checking only the original mesh vertices is insufficient.
 */
export function triangleOverlapDiagnostic(lidPoints, eyePoints) {
  return comparePrepared(prepareTriangle(lidPoints), prepareTriangle(eyePoints));
}

/** Sample the real clip and its quaternion interpolation, exactly as the viewer. */
export function sampleClip(model, mixer, sample) {
  const clip = model.clips.find(value => value.name === sample.clip);
  if (!clip || !Number.isFinite(sample.time) || sample.time < 0 || sample.time > clip.duration) {
    throw new RangeError(`Unknown or out-of-range clip sample: ${sample.clip}:${sample.time}`);
  }
  mixer.stopAllAction();
  model.reset();
  const action = mixer.clipAction(clip);
  action.reset().setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.setTime(sample.time);
  model.root.updateMatrixWorld(true);
}

/** Use indexed part triangles, actual skin weights/bind matrices and world pose. */
export function projectPartTriangles(model, partName, camera) {
  const parts = model.root.userData.parts.filter(part => part.name === partName);
  if (parts.length !== 1) throw new Error(`Expected exactly one indexed part: ${partName}`);
  const part = parts[0], mesh = model.mesh, geometry = mesh.geometry;
  const positions = geometry.getAttribute('position'), index = geometry.index;
  if (!mesh.isSkinnedMesh || !index || index.count % 3 !== 0 || !Number.isInteger(part.vertexStart)
    || !Number.isInteger(part.vertexCount) || part.vertexStart < 0 || part.vertexCount < 3
    || part.vertexStart + part.vertexCount > positions.count) throw new Error(`Invalid skinned indexed part: ${partName}`);
  model.root.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const start = part.vertexStart, end = start + part.vertexCount, transformed = new Map(), triangles = [];
  const at = vertex => {
    if (!transformed.has(vertex)) {
      const point = mesh.applyBoneTransform(vertex, new Vector3().fromBufferAttribute(positions, vertex))
        .applyMatrix4(mesh.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
      transformed.set(vertex, {x: point.x, y: point.y, z: point.z});
    }
    return transformed.get(vertex);
  };
  for (let offset = 0; offset < index.count; offset += 3) {
    const vertices = [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2)];
    const count = vertices.filter(vertex => vertex >= start && vertex < end).length;
    if (count !== 0 && count !== 3) throw new Error(`Triangle crosses the part boundary: ${partName}`);
    if (count === 3) triangles.push({part: partName, triangle: offset / 3, vertices, ...prepareTriangle(vertices.map(at))});
  }
  if (!triangles.length) throw new Error(`Part has no indexed triangles: ${partName}`);
  return triangles;
}

function compareParts(lid, eye) {
  const result = {
    status: 'unmeasured', lidTriangleCount: lid.length, eyeTriangleCount: eye.length,
    degenerateLidTriangleCount: lid.filter(triangle => triangle.degenerate).length,
    degenerateEyeTriangleCount: eye.filter(triangle => triangle.degenerate).length,
    boundingBoxPairCount: 0, overlapPairCount: 0, probeCount: 0,
    negativeGapPairCount: 0, crossingPairCount: 0,
    summedPairOverlapArea: 0, minimumDepthGap: null, worstOverlap: null,
  };
  for (const lidTriangle of lid) for (const eyeTriangle of eye) {
    if (lidTriangle.degenerate || eyeTriangle.degenerate || !boundsOverlap(lidTriangle, eyeTriangle)) continue;
    result.boundingBoxPairCount++;
    const overlap = comparePrepared(lidTriangle, eyeTriangle);
    if (overlap.status !== 'measured') continue;
    result.overlapPairCount++;
    result.probeCount += overlap.probeCount;
    result.summedPairOverlapArea += overlap.overlapArea;
    if (overlap.minimumDepthGap < -LINEAR_EPSILON) result.negativeGapPairCount++;
    if (overlap.minimumDepthGap < -LINEAR_EPSILON && overlap.maximumDepthGap > LINEAR_EPSILON) result.crossingPairCount++;
    if (result.minimumDepthGap === null || overlap.minimumDepthGap < result.minimumDepthGap) {
      result.minimumDepthGap = overlap.minimumDepthGap;
      result.worstOverlap = {
        lidTriangle: lidTriangle.triangle, eyeTriangle: eyeTriangle.triangle,
        lidVertices: lidTriangle.vertices, eyeVertices: eyeTriangle.vertices,
        ...overlap.minimum,
      };
    }
  }
  if (result.overlapPairCount > 0 && result.probeCount > 0) result.status = 'measured';
  return result;
}

export function diagnoseModel(model, config, {samples = DEFAULT_SAMPLES, views = DEFAULT_VIEWS} = {}) {
  if (!samples.length || !views.length) throw new Error('At least one clip sample and camera view are required.');
  const portrait = config.cameras?.portrait;
  if (!portrait || !Number.isFinite(portrait.height) || portrait.height <= 0
    || portrait.target?.length !== 3 || !portrait.target.every(Number.isFinite)) throw new Error('Valid portrait camera required.');
  if (views.some(angle => !Number.isFinite(angle) || Math.abs(angle) > 180)) throw new Error('Camera yaw must be finite and within ±180 degrees.');
  const mixer = new AnimationMixer(model.root), half = portrait.height / 2;
  const camera = new OrthographicCamera(-half, half, half, -half, 0.1, 30), cases = [];
  try {
    for (const sample of samples) {
      sampleClip(model, mixer, sample);
      for (const yawDegrees of views) {
        const angle = yawDegrees * Math.PI / 180;
        camera.position.set(Math.sin(angle) * 8, portrait.target[1], Math.cos(angle) * 8);
        camera.lookAt(...portrait.target);
        camera.updateMatrixWorld(true);
        for (const eye of ['Left', 'Right']) {
          const eyeSurfaces = EYE_PARTS.map(name => {
            const part = `${name}_${eye}`;
            return {part, triangles: projectPartTriangles(model, part, camera)};
          });
          for (const lid of LID_PARTS) {
            const lidPart = `${lid}_${eye}`, triangles = projectPartTriangles(model, lidPart, camera);
            cases.push({
              eye, clip: sample.clip, time: sample.time, yawDegrees, lidPart,
              role: lid === 'soft_upper_lid' ? 'required-soft-upper-lid' : 'decorative-seam-diagnostic',
              eyeSurfaces: eyeSurfaces.map(surface => ({eyePart: surface.part, ...compareParts(triangles, surface.triangles)})),
            });
          }
        }
      }
    }
  } finally {
    mixer.stopAllAction();
    mixer.uncacheRoot(model.root);
    model.reset();
  }
  return {
    schemaVersion: 1, kind: 'atlas-lid-triangle-overlap-diagnostic',
    units: 'camera-space model units; positive lid-minus-eye z means lid is nearer',
    tolerances: {linear: LINEAR_EPSILON, projectedArea: AREA_EPSILON},
    method: 'Two-sided indexed skinned triangles; convex projected intersection; affine depth minimum at every overlap vertex.',
    limitations: [
      'Pairwise negative gap is not a visible defect: another triangle, lid layer or head surface may occlude it.',
      'Open and raised poses intentionally expose the eye; overlap does not define the intended closed aperture.',
      'Zero area overlap is unmeasured, never a passing clearance result. Degenerate projections are counted and excluded.',
      'Decorative upper seam measurements are separate and cannot substitute for soft upper lid measurements.',
      'Summed pair overlap area can double-count surfaces; it is not an eye coverage fraction.',
      'Finite clip samples do not establish continuous animation, raster pixel coverage, antialiasing or visual acceptance.',
    ],
    cases,
  };
}

function parseArguments(args) {
  const options = {samples: [], views: []};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') return {help: true};
    if (!['--model', '--config', '--output', '--sample', '--view'].includes(key) || i + 1 >= args.length || args[i + 1].startsWith('--')) {
      throw new Error(`Unknown or incomplete argument: ${key}`);
    }
    const value = args[++i];
    if (key === '--sample') {
      const match = /^([a-z_]+):(\d+(?:\.\d+)?|\.\d+)$/.exec(value);
      if (!match) throw new Error('Samples must use clip:seconds, for example available:0.12.');
      options.samples.push({clip: match[1], time: Number(match[2])});
    } else if (key === '--view') options.views.push(Number(value));
    else options[key.slice(2)] = resolve(value);
  }
  return options;
}

async function main(args) {
  const options = parseArguments(args);
  if (options.help) {
    process.stdout.write('Usage: node scripts/atlas/lid-coverage.mjs [--model FILE] [--config FILE] [--output FILE]\n'
      + '       [--sample CLIP:SECONDS ...] [--view DEGREES ...]\n'
      + 'Defaults: available 0/.06/.12/.18; needs_you .34; front and ±30 degrees.\n'
      + 'Config defaults to model.json alongside the model. JSON goes to stdout unless --output is supplied.\n'
      + 'Diagnostic only: no visible-defect threshold or complete-aperture claim.\n');
    return;
  }
  const modelUrl = options.model ? pathToFileURL(options.model) : DEFAULT_MODEL;
  const configUrl = options.config ? pathToFileURL(options.config) : new URL('model.json', modelUrl);
  const [modelBytes, configBytes, imported] = await Promise.all([readFile(modelUrl), readFile(configUrl), import(modelUrl.href)]);
  if (typeof imported.createAtlas !== 'function') throw new Error('The specified module must export createAtlas(config).');
  const config = JSON.parse(configBytes.toString('utf8')), model = imported.createAtlas(config);
  let result;
  try {
    result = diagnoseModel(model, config, {
      samples: options.samples.length ? options.samples : DEFAULT_SAMPLES,
      views: options.views.length ? options.views : DEFAULT_VIEWS,
    });
  } finally {
    model.mesh.geometry.dispose();
    model.mesh.material.map?.dispose();
    model.mesh.material.dispose();
    model.mesh.skeleton.dispose();
  }
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  result.source = {
    model: fileURLToPath(modelUrl), modelSha256: sha256(modelBytes),
    config: fileURLToPath(configUrl), configSha256: sha256(configBytes),
    creativeRevision: config.creativeRevision,
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) await writeFile(options.output, json, {flag: 'wx'});
  else process.stdout.write(json);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`ATLAS lid diagnostic failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
