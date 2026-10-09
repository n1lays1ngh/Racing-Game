// Shadows near you only. The sun's shadows are drawn every frame, but only within ~45 m of your car (the shadow
// camera, scenery.js). Scenery that casts shadows and runs round the whole circuit in one piece (the catch-fence
// posts, the barriers merged into one mesh, rows of trees and buildings) was still drawn into the shadow map in full
// every frame: three.js can only skip an object that's wholly outside the shadow's area, and these never are.
//
// So each of them gets a shadow-only copy cut into squares (SHADOW_CHUNKS.cell): the copy casts the shadows, and only
// the squares near you are drawn for them. The view itself still draws the original in one go, exactly as before
// (cutting the view up too would add a draw call per square, which costs more on a Mac than the triangles it saves).
//
// How the copies stay out of the view: they're on their own layer (SHADOW_CHUNKS.layer), which the camera doesn't
// see while three.js gathers what to draw. A hook object, kept last in the scene, switches that layer on once the
// gathering is done; the shadows are drawn right after, and see it. The next render switches it off again first.
//
//   installShadowLayer(scene)   once (main.js)
//   addShadowChunks(root)       after a circuit is built, and again as models load in (main.js applyShadowCasters)
import * as THREE from 'three';

export const SHADOW_CHUNKS = {
  cell: 120,       // metres: the size of each square of the shadow copy
  layer: 1,        // the layer the shadow copies are on
  minTris: 1500,   // smaller scenery isn't worth copying
};

// ---- the layer switch ----
export function installShadowLayer(scene) {
  const L = SHADOW_CHUNKS.layer;
  const hook = new THREE.LOD(); // three.js calls update(camera) on it while gathering the view: it's last, so after the rest
  hook.name = 'shadow-layer-hook';
  hook.update = (camera) => camera.layers.enable(L);
  const before = scene.onBeforeRender;
  scene.onBeforeRender = function (renderer, s, camera, target) {
    camera.layers.disable(L);                                  // the view never sees the shadow copies
    if (s.children[s.children.length - 1] !== hook) s.add(hook); // (always last: added objects go after it)
    before.call(this, renderer, s, camera, target);
  };
}

// ---- the shadow copies ----
export function addShadowChunks(root) {
  root.updateMatrixWorld(true);
  const todo = [];
  root.traverse((o) => { if (eligible(o)) todo.push(o); });
  for (const o of todo) {
    const parts = o.isInstancedMesh ? splitInstances(o) : splitMesh(o);
    o.userData.shadowChunked = true;
    if (!parts) continue;
    const casts = o.userData.castShadow0 ?? o.castShadow;
    for (const c of parts) {
      c.name = o.name; c.position.copy(o.position); c.quaternion.copy(o.quaternion); c.scale.copy(o.scale);
      c.layers.set(SHADOW_CHUNKS.layer);
      c.castShadow = o.castShadow; c.receiveShadow = false;
      c.customDepthMaterial = o.customDepthMaterial; c.customDistanceMaterial = o.customDistanceMaterial;
      c.userData = { shadowChunk: true, castShadow0: casts };
      o.parent.add(c);
    }
    // the original keeps drawing the view, and no longer casts (main.js applyShadowCasters reads castShadow0)
    o.userData.castShadow0 = false; o.castShadow = false;
    o.addEventListener('removed', () => parts.forEach((c) => { c.removeFromParent(); if (c.isInstancedMesh) c.dispose(); else c.geometry.dispose(); }));
  }
  return todo.length;
}

function eligible(o) {
  if (!o.isMesh || !o.parent || !o.visible || o.userData.shadowChunk || o.userData.shadowChunked || o.isSkinnedMesh) return false;
  if (!(o.userData.castShadow0 ?? o.castShadow)) return false;                  // never casts a shadow: nothing to do
  for (let p = o; p; p = p.parent) if (p.userData?.cull) return false;          // shown only up close already (scenery.js)
  const g = o.geometry;
  if (!g?.attributes?.position || Object.keys(g.morphAttributes).length) return false;
  for (const a of Object.values(g.attributes)) if (!a.isBufferAttribute || a.usage === THREE.DynamicDrawUsage) return false;
  const tris = ((g.index ? g.index.count : g.attributes.position.count) / 3) * (o.isInstancedMesh ? o.count : 1);
  if (tris < SHADOW_CHUNKS.minTris) return false;
  if (o.isInstancedMesh) {
    if (o.instanceMatrix.usage === THREE.DynamicDrawUsage) return false;
    o.computeBoundingSphere();
    if (o.boundingSphere.radius <= SHADOW_CHUNKS.cell) { o.userData.shadowChunked = true; return false; } // (small: don't check again)
    return true;
  }
  if (!g.boundingSphere) g.computeBoundingSphere();
  return g.boundingSphere.radius * o.matrixWorld.getMaxScaleOnAxis() > SHADOW_CHUNKS.cell;
}

const cellKey = (x, z) => `${Math.floor(x / SHADOW_CHUNKS.cell)},${Math.floor(z / SHADOW_CHUNKS.cell)}`;

// Instanced scenery (posts, trees, buildings): its instances, square by square
function splitInstances(o) {
  const m = new THREE.Matrix4(), w = new THREE.Matrix4(), cells = new Map();
  for (let k = 0; k < o.count; k++) {
    o.getMatrixAt(k, m); w.multiplyMatrices(o.matrixWorld, m);
    const key = cellKey(w.elements[12], w.elements[14]);
    (cells.get(key) ?? cells.set(key, []).get(key)).push(k);
  }
  if (cells.size < 2) return null;
  const parts = [];
  for (const list of cells.values()) {
    const c = new THREE.InstancedMesh(o.geometry, o.material, list.length);
    list.forEach((k, j) => { o.getMatrixAt(k, m); c.setMatrixAt(j, m); });
    c.computeBoundingSphere();
    parts.push(c);
  }
  return parts;
}

// One merged mesh (barriers, fences, kerbs): its triangles, square by square (by the middle of each triangle), keeping
// every vertex attribute and the material groups
function splitMesh(o) {
  const g = o.geometry, pos = g.attributes.position, idx = g.index, n = idx ? idx.count : pos.count, W = o.matrixWorld.elements;
  const groups = g.groups.length ? g.groups : [{ start: 0, count: n, materialIndex: 0 }];
  const cells = new Map(); // key → Map(materialIndex → [vertex indices])
  for (const gr of groups) {
    const end = Math.min(n, gr.start + gr.count);
    for (let t = gr.start; t + 2 < end; t += 3) {
      const a = idx ? idx.getX(t) : t, b = idx ? idx.getX(t + 1) : t + 1, c = idx ? idx.getX(t + 2) : t + 2;
      const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3, z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
      const key = cellKey(W[0] * x + W[4] * y + W[8] * z + W[12], W[2] * x + W[6] * y + W[10] * z + W[14]);
      let cell = cells.get(key); if (!cell) cells.set(key, (cell = new Map()));
      let list = cell.get(gr.materialIndex ?? 0); if (!list) cell.set(gr.materialIndex ?? 0, (list = []));
      list.push(a, b, c);
    }
  }
  if (cells.size < 2) return null;
  const remap = new Int32Array(pos.count).fill(-1), parts = [], multi = Array.isArray(o.material);
  for (const cell of cells.values()) {
    const order = [], index = [], outGroups = [];
    for (const [mi, list] of cell) {
      const start = index.length;
      for (const v of list) { let r = remap[v]; if (r < 0) { r = remap[v] = order.length; order.push(v); } index.push(r); }
      outGroups.push([start, list.length, mi]);
    }
    const ng = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(g.attributes)) {
      const s = attr.itemSize, src = attr.array, dst = new src.constructor(order.length * s);
      for (let j = 0; j < order.length; j++) for (let q = 0; q < s; q++) dst[j * s + q] = src[order[j] * s + q];
      ng.setAttribute(name, new THREE.BufferAttribute(dst, s, attr.normalized));
    }
    ng.setIndex(new THREE.BufferAttribute(order.length > 65535 ? new Uint32Array(index) : new Uint16Array(index), 1));
    if (multi) for (const [start, count, mi] of outGroups) ng.addGroup(start, count, mi);
    ng.computeBoundingSphere();
    for (const v of order) remap[v] = -1;
    parts.push(new THREE.Mesh(ng, o.material));
  }
  return parts;
}