import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  AnimationClip, AnimationMixer, Bone, BufferGeometry, Float32BufferAttribute,
  Group, MeshBasicMaterial, OrthographicCamera, Quaternion, QuaternionKeyframeTrack,
  Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3,
} from 'three';
import {createAtlas} from '../../.design/asael-ace-revamp/atlas-production/source/atlas-model.mjs';
import {DEFAULT_SAMPLES, DEFAULT_VIEWS, diagnoseModel, projectPartTriangles, sampleClip, triangleOverlapDiagnostic} from './lid-coverage.mjs';

const triangle = coordinates => coordinates.map(([x, y, z]) => ({x, y, z}));
const close = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≈ ${expected}`);
const flatEye = triangle([[0, 0, 0], [2, 0, 0], [0, 2, 0]]);

test('coincident projections give the exact affine depth extrema, independent of triangle winding', () => {
  const lid = triangle([[0, 0, 0.25], [2, 0, 0.75], [0, 2, 1.25]]);
  for (const a of [lid, [...lid].reverse()]) for (const b of [flatEye, [...flatEye].reverse()]) {
    const result = triangleOverlapDiagnostic(a, b);
    assert.equal(result.status, 'measured');
    assert.equal(result.probeCount, 3);
    close(result.overlapArea, 2);
    close(result.minimumDepthGap, 0.25);
    close(result.maximumDepthGap, 1.25);
  }
});

test('new overlap vertices find an interior crossing that original-vertex probes miss', () => {
  // Opposing triangles form a hexagon, with no original vertex in the other
  // triangle. The lid plane z=y crosses the eye plane inside that overlap.
  const lid = triangle([[-2, -1, -1], [2, -1, -1], [0, 2, 2]]);
  const eye = triangle([[-2, 1, 0], [2, 1, 0], [0, -2, 0]]);
  const inside = (point, shape) => {
    const crosses = shape.map((a, i) => {
      const b = shape[(i + 1) % 3];
      return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    });
    return crosses.every(value => value >= 0) || crosses.every(value => value <= 0);
  };
  assert.ok(lid.every(point => !inside(point, eye)));
  assert.ok(eye.every(point => !inside(point, lid)));
  const result = triangleOverlapDiagnostic(lid, eye);
  assert.equal(result.status, 'measured');
  assert.equal(result.probeCount, 6);
  close(result.overlapArea, 4);
  close(result.minimumDepthGap, -1);
  close(result.maximumDepthGap, 1);
  for (const probe of result.probes) {
    close(probe.depthGap, probe.y);
    assert.ok([...lid, ...eye].every(point => Math.hypot(point.x - probe.x, point.y - probe.y) > 0.1));
  }
});

test('depth is interpolated on both surfaces, not compared only with a fixed eye plane', () => {
  const eye = triangle([[0, 0, -2], [2, 0, 2], [0, 2, -2]]);
  const lid = triangle([[0, 0, -1.7], [2, 0, 2.3], [0, 2, -1.7]]);
  const result = triangleOverlapDiagnostic(lid, eye);
  close(result.minimumDepthGap, 0.3);
  close(result.maximumDepthGap, 0.3);
  const swapped = triangleOverlapDiagnostic(eye, lid);
  close(swapped.minimumDepthGap, -0.3);
  close(swapped.maximumDepthGap, -0.3);
});

test('disjoint, edge-only and point-only projections never report measured clearance', () => {
  for (const lid of [
    triangle([[3, 0, 1], [4, 0, 1], [3, 1, 1]]),
    triangle([[0, 0, 1], [2, 0, 1], [0, -2, 1]]),
    triangle([[2, 0, 1], [3, 0, 1], [2, -1, 1]]),
  ]) {
    const result = triangleOverlapDiagnostic(lid, flatEye);
    assert.equal(result.status, 'no-area-overlap');
    assert.equal(result.probeCount, 0);
    assert.equal(result.minimumDepthGap, null);
  }
});

test('edge-on and duplicate-vertex projections are excluded explicitly, without NaN or a vacuous pass', () => {
  for (const degenerate of [
    triangle([[0, 0, -1], [1, 0, 1], [2, 0, 2]]),
    triangle([[0, 0, 1], [0, 0, 2], [1, 1, 2]]),
    triangle([[0, 0, 1], [1e-8, 0, 1], [0, 1e-8, 1]]),
  ]) for (const [lid, eye] of [[degenerate, flatEye], [flatEye, degenerate]]) {
    assert.deepEqual(triangleOverlapDiagnostic(lid, eye), {
      status: 'degenerate-projection', probeCount: 0, minimumDepthGap: null,
    });
  }
});

test('a narrow positive-area overlap remains measured instead of being rounded to empty', () => {
  const lid = triangle([[2 - 1e-5, 0, 0.1], [3, 0, 0.1], [2 - 1e-5, 1, 0.1]]);
  const result = triangleOverlapDiagnostic(lid, flatEye);
  assert.equal(result.status, 'measured');
  assert.ok(result.overlapArea > 1e-14 && result.overlapArea < 1e-9);
  close(result.minimumDepthGap, 0.1);
});

test('invalid coordinates are rejected before affine arithmetic', () => {
  assert.throws(() => triangleOverlapDiagnostic([{x: 0, y: 0, z: NaN}, ...flatEye.slice(1)], flatEye), /finite/);
  assert.throws(() => triangleOverlapDiagnostic(flatEye.slice(1), flatEye), /three finite/);
});

function skinnedFixture() {
  const root = new Group(), bone = new Bone();
  bone.name = 'Lid';
  root.add(bone);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 4, 4, 4], 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(Array(16).fill(0), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.setIndex([0, 1, 2]);
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new Skeleton([bone]));
  root.userData.parts = [{name: 'lid', vertexStart: 0, vertexCount: 3}];
  const q = degrees => new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), degrees * Math.PI / 180).toArray();
  const clips = [new AnimationClip('available', 0.24, [new QuaternionKeyframeTrack('Lid.quaternion', [0, 0.12, 0.24], [...q(0), ...q(68), ...q(0)])])];
  const reset = () => {bone.quaternion.identity(); bone.position.set(0, 0, 0); root.updateMatrixWorld(true);};
  const dispose = () => {geometry.dispose(); mesh.material.dispose(); mesh.skeleton.dispose();};
  return {root, mesh, bone, clips, reset, dispose};
}

test('projection uses indexed triangles and the animated bone plus root/world camera transforms', () => {
  const model = skinnedFixture(), mixer = new AnimationMixer(model.root);
  const camera = new OrthographicCamera(-2, 2, 2, -2, 0.1, 30);
  camera.position.set(0, 0, 8);
  camera.lookAt(0, 0, 0);
  model.root.position.set(2, 3, 0.5);
  try {
    sampleClip(model, mixer, {clip: 'available', time: 0.12});
    const triangles = projectPartTriangles(model, 'lid', camera);
    assert.equal(triangles.length, 1, 'unused fourth vertex is not a face');
    assert.deepEqual(triangles[0].vertices, [0, 1, 2]);
    close(triangles[0].points[0].x, 2);
    close(triangles[0].points[0].y, 3);
    close(triangles[0].points[0].z, -7.5);
    close(triangles[0].points[2].y, 3 + Math.cos(68 * Math.PI / 180), 1e-7);
    close(triangles[0].points[2].z, -7.5 + Math.sin(68 * Math.PI / 180), 1e-7);
    sampleClip(model, mixer, {clip: 'available', time: 0.06});
    close(projectPartTriangles(model, 'lid', camera)[0].points[2].y, 3 + Math.cos(34 * Math.PI / 180), 1e-7);
    sampleClip(model, mixer, {clip: 'available', time: 0});
    close(projectPartTriangles(model, 'lid', camera)[0].points[2].y, 4);
    assert.throws(() => sampleClip(model, mixer, {clip: 'missing', time: 0}), /Unknown/);
    assert.throws(() => sampleClip(model, mixer, {clip: 'available', time: 0.25}), /out-of-range/);
    assert.throws(() => projectPartTriangles(model, 'missing', camera), /exactly one/);
    model.root.userData.parts[0].vertexCount = 2;
    assert.throws(() => projectPartTriangles(model, 'lid', camera), /Invalid/);
  } finally {
    mixer.stopAllAction();
    mixer.uncacheRoot(model.root);
    model.dispose();
  }
});

test('default diagnostics include the rejected review poses and front/±30-degree views', () => {
  assert.ok(DEFAULT_SAMPLES.some(sample => sample.clip === 'available' && sample.time === 0.12));
  assert.ok(DEFAULT_SAMPLES.some(sample => sample.clip === 'needs_you' && sample.time === 0.34));
  assert.ok(DEFAULT_SAMPLES.some(sample => sample.clip === 'available' && sample.time > 0 && sample.time < 0.12));
  assert.deepEqual(DEFAULT_VIEWS, [0, -30, 30]);
});

test('retained soft upper lids stay ahead of overlapping eye highlights at the exact closed clip sample', async () => {
  const config = JSON.parse(await readFile(new URL('../../.design/asael-ace-revamp/atlas-production/source/model.json', import.meta.url), 'utf8'));
  const model = createAtlas(config), views = [0, -30, 30];
  try {
    const report = diagnoseModel(model, config, {samples: [{clip: 'available', time: 0.12}], views});
    const cases = report.cases.filter(value => value.role === 'required-soft-upper-lid');
    const expected = views.flatMap(view => ['Left', 'Right'].map(eye => `${eye}:${view}`));
    assert.deepEqual(cases.map(value => `${value.eye}:${value.yawDegrees}`).sort(), expected.sort(),
      'both eyes must be measured independently at all three views');
    for (const sample of cases) {
      const label = `${sample.eye}, available .12, yaw ${sample.yawDegrees}`;
      assert.equal(sample.lidPart, `soft_upper_lid_${sample.eye}`, `${label}: decorative seam cannot substitute`);
      const highlight = sample.eyeSurfaces.find(value => value.eyePart === `eye_highlight_${sample.eye}`);
      assert.ok(highlight, `${label}: actual indexed highlight required`);
      assert.equal(highlight.status, 'measured', `${label}: no overlap is not clearance`);
      assert.ok(highlight.overlapPairCount > 0 && highlight.probeCount >= 3, `${label}: nonempty area probes required`);
      assert.ok(Number.isFinite(highlight.minimumDepthGap), `${label}: finite depth gap required`);
      // Archived FACE03 measured a negative gap in each of these six cases.
      // This guards that specific closed-highlight crossing, not the entire
      // aperture, raised poses, continuous playback or rendered visibility.
      assert.ok(highlight.minimumDepthGap >= 1e-10,
        `${label}: soft lid/highlight separation must exceed numerical tolerance; got ${highlight.minimumDepthGap}`);
    }
  } finally {
    model.mesh.geometry.dispose();
    model.mesh.material.map?.dispose();
    model.mesh.material.dispose();
    model.mesh.skeleton.dispose();
  }
});
