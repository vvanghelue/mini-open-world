import type { Object3D } from 'three/webgpu';

/** Marks an object tree as static: matrices are computed once and no longer recomposed / multiplied on every
 *  render call (three updates the whole scene graph per render: main pass + each shadow cascade). */
export function freezeStatic(root: Object3D) {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    o.matrixAutoUpdate = false;
    o.matrixWorldAutoUpdate = false;
  });
}
