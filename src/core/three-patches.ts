// Small runtime patches of three.js internals (r186). Imported first by main.ts.
import * as THREE from 'three/webgpu';

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
