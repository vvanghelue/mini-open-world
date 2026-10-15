// Small runtime patches of three.js internals (r186). Imported first by main.ts.
import * as THREE from 'three/webgpu';
import { positionLocal, positionPrevious } from 'three/tsl';

// `material.userData.invariantPosition = true` marks the vertex position output @invariant, so two different
// shaders computing the same position expression produce bit-identical depth (required by depth pre-pass +
// EQUAL-depth shading: Metal may otherwise compile the same math differently in each program).
const proto = (THREE as any).WGSLNodeBuilder.prototype;
const getBuiltins = proto.getBuiltins;
proto.getBuiltins = function (this: any, stage: string) {
  const s: string = getBuiltins.call(this, stage);
  if (stage === 'vertex' && this.material?.userData?.invariantPosition) return s.replace('@builtin( position )', '@invariant @builtin( position )');
  return s;
};

// Shadow pass: three renders every caster with ONE shared override material and copies the caster's alphaTest onto
// it. The Material.alphaTest setter bumps `version` whenever the value crosses 0, so mixing cut-out casters (foliage)
// with opaque ones (buildings, rocks) bumped the shared material's version several times per frame, and every
// shadow render object then recomputed its full cache key (material properties + node graph hashing): ~1 ms of JS
// per frame. Each caster has its own render object in that pass, built from its own (stable) override state, so the
// bumps are useless there: they are suppressed for shadow-pass materials only.
const matProto = THREE.Material.prototype as any;
const alphaDesc = Object.getOwnPropertyDescriptor(matProto, 'alphaTest')!;
Object.defineProperty(matProto, 'alphaTest', {
  configurable: true,
  get: alphaDesc.get,
  set(this: any, value: number) {
    if (this.isShadowPassMaterial) this._alphaTest = value;
    else alphaDesc.set!.call(this, value);
  },
});

// Motion vectors: VelocityNode projects `positionPrevious`, which is the raw geometry attribute unless something
// (instancing, skinning) updates it. Every material with a custom positionNode (CDLOD terrain, GPU-scattered trees and
// grass, rocks, buildings) then got garbage motion vectors (grid/card coordinates instead of the displaced position):
// the TAA resolve rejected its history there and showed the raw jittered frame, so shadows, foliage and the ground
// shimmered. Those objects are static in world space, so the previous position is the current one (camera motion
// still comes from the previous camera matrices; wind sway is left to the history clamp).
const nodeMatProto = (THREE as any).NodeMaterial.prototype;
const setupPosition = nodeMatProto.setupPosition;
nodeMatProto.setupPosition = function (this: any, builder: any) {
  const p = setupPosition.call(this, builder);
  if (this.positionNode !== null && builder.needsPreviousData()) positionPrevious.assign(positionLocal);
  return p;
};
