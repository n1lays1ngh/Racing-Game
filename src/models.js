// 3D models from public/models/ (floodlight towers, city buildings), loaded once and drawn instanced:
// every copy of a model shares one draw call per material, however many there are.
//   loadModel(name)            → Promise of { parts, size } (or null if the file can't be loaded)
//   instanceModel(model, list) → InstancedMeshes for a list of { x, y, z, yaw, sx, sy, sz }
//
// parts: the model's meshes merged by material, in the model's own coordinates (metres, base at y = 0).
// Credits for the models are in README.md.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const cache = new Map();
const loader = new GLTFLoader();

// name: file in public/models/; node: only use this node and what's under it (e.g. one building of a pack)
export function loadModel(name, node = null) {
  const key = `${name}#${node ?? ''}`;
  if (!cache.has(key)) {
    const file = cache.get(name) ?? loader.loadAsync(`/models/${name}`);
    cache.set(name, file);
    cache.set(key, file.then((gltf) => {
      const root = node ? gltf.scene.getObjectByName(node) : gltf.scene;
      if (!root) return null;
      root.updateMatrixWorld(true);
      const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert(); // the node's own place in the file doesn't matter
      const byMaterial = new Map();
      root.traverse((o) => {
        if (!o.isMesh) return;
        const g = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, o.matrixWorld));
        for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
        if (!g.attributes.normal) g.computeVertexNormals();
        const list = byMaterial.get(o.material) ?? [];
        list.push(g.index ? g : g.setIndex([...Array(g.attributes.position.count).keys()]));
        byMaterial.set(o.material, list);
      });
      const parts = [...byMaterial].map(([material, geos]) => {
        const hasUv = geos.every((g) => g.attributes.uv);
        if (!hasUv) geos.forEach((g) => g.deleteAttribute('uv'));
        return { material, geometry: mergeGeometries(geos) };
      });
      const box = new THREE.Box3();
      parts.forEach((p) => { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox); });
      return { parts, size: box.getSize(new THREE.Vector3()), box };
    }).catch((err) => { console.warn(`Model /models/${name} not loaded, using the built-in shapes instead.`, err); return null; }));
  }
  return cache.get(key);
}

// Is this object still part of what's being drawn? (false once its circuit has been unloaded)
export function inScene(o) { while (o.parent) o = o.parent; return !!o.isScene; }

// One InstancedMesh per material. list: { x, y, z, yaw, sx, sy, sz } (scale defaults to 1).
// Geometry is copied per call, so each circuit can free its own when it's unloaded.
export function instanceModel(model, list, { shadows = true, material = null } = {}) {
  if (!model || !list.length) return [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  return model.parts.map((part) => {
    const mesh = new THREE.InstancedMesh(part.geometry.clone(), material?.(part.material) ?? part.material, list.length);
    list.forEach((t, k) => mesh.setMatrixAt(k, m.compose(p.set(t.x, t.y, t.z), q.setFromAxisAngle(up, t.yaw ?? 0), s.set(t.sx ?? t.s ?? 1, t.sy ?? t.s ?? 1, t.sz ?? t.s ?? 1))));
    mesh.castShadow = shadows; mesh.receiveShadow = true; mesh.computeBoundingSphere();
    return mesh;
  });
}