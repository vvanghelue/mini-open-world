// Dev page: renders the procedural tree variants side by side for quick visual iteration.
// Open http://localhost:5173/tree-lab.html (?lod=1, ?view=far).
import * as THREE from 'three/webgpu';
import { generateTree, TREE_PRESETS, TwigRect } from '../vegetation/tree-generator';
import { makeFoliageMaterial, makeBarkMaterial } from '../vegetation/tree-materials';
import { loadBitmapTexture } from '../terrain/terrain-textures';
import { dataUrl, fetchJson } from '../core/data';

const params = new URLSearchParams(location.search);
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
await renderer.init();
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9bb7d4);
const sun = new THREE.DirectionalLight(0xfff2e0, 3.2);
sun.position.set(30, 50, 40);
scene.add(sun, new THREE.HemisphereLight(0xbfd8ff, 0x50483a, 1.0));
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardNodeMaterial({ color: 0x4a5a30 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const meta = await fetchJson('trees/twigs.json');
const twigs: TwigRect[] = meta.twigs;
const [twigAlbedo, twigNormal, barkAlbedo, barkNormal] = await Promise.all([
  loadBitmapTexture(dataUrl('trees/twig_albedo.png'), true),
  loadBitmapTexture(dataUrl('trees/twig_normal.png'), false),
  loadBitmapTexture(dataUrl('trees/bark_albedo.jpg'), true),
  loadBitmapTexture(dataUrl('trees/bark_normal.jpg'), false),
]);
for (const t of [barkAlbedo, barkNormal]) t.wrapS = t.wrapT = THREE.RepeatWrapping;
const tx = { twigAlbedo, twigNormal, barkAlbedo, barkNormal };
const lod = Number(params.get('lod') || 0) as 0 | 1;
let x = -((TREE_PRESETS.length - 1) * 12) / 2;
const info: string[] = [];
for (const p of TREE_PRESETS) {
  const t = generateTree(p, twigs, lod);
  const f = new THREE.Mesh(t.foliage, makeFoliageMaterial(tx, null, new THREE.Color(...p.tint)));
  const b = new THREE.Mesh(t.bark, makeBarkMaterial(tx, null));
  f.position.x = b.position.x = x;
  scene.add(f, b);
  info.push(`${p.name}: ${(t.foliage.index!.count / 3) | 0} + ${(t.bark.index!.count / 3) | 0} tris`);
  x += 12;
}
const cam = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 2000);
const far = params.get('view') === 'far';
cam.position.set(0, far ? 40 : 14, far ? 170 : 55);
cam.lookAt(0, far ? 12 : 13, 0);
(window as any).treeLab = { info, ready: true };
renderer.setAnimationLoop(() => renderer.render(scene, cam));
