// Procedural light aircraft (Cessna 172-like, high wing). Local frame: +X right wing, +Y up, -Z forward (nose),
// origin at the centre of gravity, wheels touching y = -GEAR_HEIGHT.
import * as THREE from 'three/webgpu';

export const GEAR_HEIGHT = 1.25; // CG height above the ground when sitting on its wheels (m)

// gear contact points (local), used by the flight model
export const GEAR_POINTS = [
  new THREE.Vector3(0, -GEAR_HEIGHT, -1.55), // nose wheel
  new THREE.Vector3(-1.25, -GEAR_HEIGHT, 0.45), // left main
  new THREE.Vector3(1.25, -GEAR_HEIGHT, 0.45), // right main
];

function loft(sections: Array<{ z: number; w: number; h: number; y: number }>, radial = 20) {
  // elliptical cross-sections along z
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    for (let a = 0; a <= radial; a++) {
      const t = (a / radial) * Math.PI * 2;
      pos.push(Math.cos(t) * s.w * 0.5, s.y + Math.sin(t) * s.h * 0.5, s.z);
    }
  }
  for (let i = 0; i < sections.length - 1; i++) for (let a = 0; a < radial; a++) {
    const p0 = i * (radial + 1) + a, p1 = p0 + 1, p2 = p0 + radial + 1, p3 = p2 + 1;
    idx.push(p0, p2, p1, p1, p2, p3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function airfoilWing(span: number, chord: number, thickness: number, sweep = 0, taper = 1) {
  // NACA-like symmetric profile extruded along +X (span), leading edge towards -Z
  const shape = new THREE.Shape();
  const n = 16;
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= n; i++) {
    const x = 1 - i / n;
    const yt = 5 * thickness * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4);
    pts.push(new THREE.Vector2(x * chord, yt * chord));
  }
  for (let i = 1; i < n; i++) {
    const x = i / n;
    const yt = 5 * thickness * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4);
    pts.push(new THREE.Vector2(x * chord, -yt * chord));
  }
  shape.setFromPoints(pts);
  const g = new THREE.ExtrudeGeometry(shape, { depth: span, bevelEnabled: false, steps: 1 });
  // shape is in XY (x along chord, y thickness), extruded along +Z -> rotate so span is X, chord is Z
  g.rotateY(-Math.PI / 2);
  g.translate(span, 0, 0);
  // taper and sweep towards the tip
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const t = Math.abs(x) / span;
    const k = 1 + (taper - 1) * t;
    p.setZ(i, p.getZ(i) * k + sweep * t);
    p.setY(i, p.getY(i) * k);
  }
  g.computeVertexNormals();
  return g;
}

export function buildPlane() {
  const group = new THREE.Group();
  group.name = 'aircraft';
  const paint = new THREE.MeshStandardNodeMaterial({ color: 0xf2f2f0, roughness: 0.32, metalness: 0.0 });
  const stripe = new THREE.MeshStandardNodeMaterial({ color: 0x1d3f8c, roughness: 0.35, metalness: 0.0 });
  const stripe2 = new THREE.MeshStandardNodeMaterial({ color: 0xb8232c, roughness: 0.35, metalness: 0.0 });
  const glass = new THREE.MeshStandardNodeMaterial({ color: 0x1a2430, roughness: 0.05, metalness: 0.2 });
  const dark = new THREE.MeshStandardNodeMaterial({ color: 0x222222, roughness: 0.6, metalness: 0.2 });
  const tyre = new THREE.MeshStandardNodeMaterial({ color: 0x111111, roughness: 0.9 });
  const metal = new THREE.MeshStandardNodeMaterial({ color: 0x9aa0a6, roughness: 0.3, metalness: 0.9 });

  // fuselage (nose at -z)
  const fus = loft([
    { z: -3.55, w: 0.25, h: 0.25, y: 0.05 },
    { z: -3.35, w: 0.9, h: 0.85, y: 0.05 },
    { z: -2.6, w: 1.05, h: 1.1, y: 0.1 },
    { z: -1.6, w: 1.15, h: 1.35, y: 0.2 },
    { z: -0.6, w: 1.18, h: 1.42, y: 0.22 },
    { z: 0.6, w: 1.1, h: 1.3, y: 0.22 },
    { z: 1.8, w: 0.75, h: 0.95, y: 0.32 },
    { z: 3.2, w: 0.4, h: 0.6, y: 0.45 },
    { z: 4.35, w: 0.12, h: 0.35, y: 0.55 },
  ]);
  const fusMesh = new THREE.Mesh(fus, paint);
  group.add(fusMesh);
  // cabin windows (slightly inflated dark band)
  const win = loft([
    { z: -1.45, w: 1.17, h: 0.62, y: 0.55 },
    { z: -0.6, w: 1.2, h: 0.68, y: 0.57 },
    { z: 0.55, w: 1.12, h: 0.6, y: 0.55 },
  ]);
  group.add(new THREE.Mesh(win, glass));
  // stripe along the fuselage
  const st = loft([
    { z: -3.0, w: 1.0, h: 0.12, y: -0.15 },
    { z: -1.6, w: 1.17, h: 0.14, y: -0.12 },
    { z: 0.6, w: 1.12, h: 0.14, y: -0.05 },
    { z: 3.2, w: 0.42, h: 0.1, y: 0.4 },
  ]);
  group.add(new THREE.Mesh(st, stripe));

  // high wing (two halves with slight dihedral), on top of the cabin
  for (const side of [-1, 1]) {
    const w = airfoilWing(5.4, 1.55, 0.15, 0.1, 0.75);
    const m = new THREE.Mesh(w, paint);
    m.position.set(0, 0.95, -1.1);
    if (side < 0) m.scale.x = -1;
    m.rotation.z = side * THREE.MathUtils.degToRad(1.7);
    group.add(m);
    // wing tip stripe
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.14, 1.2), stripe2);
    tip.position.set(side * 5.45, 1.1, -0.45);
    group.add(tip);
    // strut
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.6, 8), metal);
    strut.position.set(side * 1.45, 0.25, -0.5);
    strut.rotation.z = side * -1.05;
    group.add(strut);
    // main gear leg + wheel
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.0, 8), metal);
    leg.position.set(side * 0.95, -0.85, 0.45);
    leg.rotation.z = side * 0.55;
    group.add(leg);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.16, 18), tyre);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(side * 1.25, -GEAR_HEIGHT + 0.27, 0.45);
    group.add(wheel);
    // horizontal stabiliser
    const hs = airfoilWing(1.7, 0.95, 0.1, 0.25, 0.7);
    const hm = new THREE.Mesh(hs, paint);
    hm.position.set(0, 0.5, 3.35);
    if (side < 0) hm.scale.x = -1;
    group.add(hm);
  }
  // vertical fin
  const finShape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(1.3, 0), new THREE.Vector2(1.45, 1.45), new THREE.Vector2(0.85, 1.5)]);
  const fin = new THREE.ExtrudeGeometry(finShape, { depth: 0.08, bevelEnabled: false });
  fin.rotateY(Math.PI / 2);
  fin.translate(0.04, 0.55, 4.45);
  const finMesh = new THREE.Mesh(fin, paint);
  finMesh.scale.z = -1;
  finMesh.position.z = 7.85;
  group.add(finMesh);
  // nose gear
  const nleg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.9, 8), metal);
  nleg.position.set(0, -0.75, -1.55);
  group.add(nleg);
  const nwheel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.12, 16), tyre);
  nwheel.rotation.z = Math.PI / 2;
  nwheel.position.set(0, -GEAR_HEIGHT + 0.22, -1.55);
  group.add(nwheel);
  // spinner + propeller
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.4, 16), metal);
  spinner.rotation.x = -Math.PI / 2;
  spinner.position.set(0, 0.05, -3.75);
  group.add(spinner);
  const prop = new THREE.Group();
  prop.position.set(0, 0.05, -3.6);
  for (const a of [0, Math.PI]) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.95, 0.03), dark);
    blade.position.y = 0.48;
    const holder = new THREE.Group();
    holder.rotation.z = a;
    holder.add(blade);
    prop.add(holder);
  }
  group.add(prop);
  // propeller disc (motion blur stand-in at high rpm)
  const discMat = new THREE.MeshBasicNodeMaterial({ color: 0x202020, transparent: true, opacity: 0.18, depthWrite: false });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.97, 32), discMat);
  disc.position.set(0, 0.05, -3.62);
  disc.rotation.y = Math.PI;
  group.add(disc);

  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  disc.castShadow = false;

  // ---------------------------------------------------------------- cockpit interior (visible in cockpit view)
  const cockpit = new THREE.Group();
  const panelMat = new THREE.MeshStandardNodeMaterial({ color: 0x4a4f58, roughness: 0.75, emissive: 0x0d0e10 });
  const frameMat = new THREE.MeshStandardNodeMaterial({ color: 0xd8d8d4, roughness: 0.5 });
  const dash = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.42, 0.12), panelMat);
  dash.position.set(0, 0.24, -1.38);
  cockpit.add(dash);
  const glare = new THREE.Mesh(new THREE.BoxGeometry(1.14, 0.05, 0.32), panelMat);
  glare.position.set(0, 0.47, -1.42);
  cockpit.add(glare);
  // instrument faces drawn on a canvas
  const cv = document.createElement('canvas');
  cv.width = 1024;
  cv.height = 384;
  const g2 = cv.getContext('2d')!;
  g2.fillStyle = '#25272b';
  g2.fillRect(0, 0, cv.width, cv.height);
  const labels = ['KT', 'ATT', 'ALT', 'TURN', 'HDG', 'VS'];
  labels.forEach((lab, i) => {
    const cx = 110 + (i % 3) * 170 + (i >= 3 ? 0 : 0), cy = i < 3 ? 105 : 280;
    g2.fillStyle = '#0c0d0f';
    g2.beginPath(); g2.arc(cx, cy, 72, 0, Math.PI * 2); g2.fill();
    g2.strokeStyle = '#d9d9d9'; g2.lineWidth = 3;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      g2.beginPath(); g2.moveTo(cx + Math.cos(a) * 58, cy + Math.sin(a) * 58); g2.lineTo(cx + Math.cos(a) * 68, cy + Math.sin(a) * 68); g2.stroke();
    }
    if (lab === 'ATT') {
      g2.fillStyle = '#3a6db5'; g2.beginPath(); g2.arc(cx, cy, 55, Math.PI, 0); g2.fill();
      g2.fillStyle = '#7a5530'; g2.beginPath(); g2.arc(cx, cy, 55, 0, Math.PI); g2.fill();
    }
    g2.fillStyle = '#e6e6e6'; g2.font = 'bold 20px sans-serif'; g2.textAlign = 'center'; g2.fillText(lab, cx, cy + 35);
  });
  // radio stack
  g2.fillStyle = '#111'; g2.fillRect(620, 40, 330, 300);
  g2.fillStyle = '#5fe08a'; g2.font = '28px monospace'; g2.fillText('COM 121.500', 785, 110); g2.fillText('NAV 110.900', 785, 170); g2.fillText('XPDR 7000', 785, 230);
  const instTex = new THREE.CanvasTexture(cv);
  instTex.colorSpace = THREE.SRGBColorSpace;
  const faces = new THREE.Mesh(new THREE.PlaneGeometry(1.06, 0.4), new THREE.MeshStandardNodeMaterial({ map: instTex, roughness: 0.4 }));
  faces.position.set(0, 0.24, -1.315);
  cockpit.add(faces);
  // windshield / door frame posts
  for (const side of [-1, 1]) {
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.62, 0.03), frameMat);
    a.position.set(side * 0.55, 0.72, -1.2);
    a.rotation.x = -0.75;
    cockpit.add(a);
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.8, 0.06), frameMat);
    b.position.set(side * 0.6, 0.6, -0.4);
    cockpit.add(b);
    const sill = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 1.3), frameMat);
    sill.position.set(side * 0.6, 0.2, -0.9);
    cockpit.add(sill);
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.04, 1.2), panelMat);
  roof.position.set(0, 0.97, -0.9);
  cockpit.add(roof);
  // yoke
  const yoke = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.018, 8, 20, Math.PI), panelMat);
  yoke.position.set(-0.32, 0.25, -1.1);
  yoke.rotation.z = Math.PI;
  cockpit.add(yoke);
  cockpit.visible = false;
  group.add(cockpit);
  const exterior: THREE.Mesh[] = [fusMesh as THREE.Mesh];
  group.children.forEach((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh && (m.material === glass || m.material === stripe)) exterior.push(m);
  });
  return { group, prop, disc, discMat, cockpit, exterior };
}
