// Static world colliders for the walker (and later other actors): each one pushes a circle (x, z, radius) out of
// its obstacles. Systems register themselves once their data is loaded.
export type CircleCollider = (p: { x: number; z: number }, radius: number) => void;

export const worldColliders: CircleCollider[] = [];
