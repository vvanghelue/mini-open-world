// Adaptive rendering state shared between the governor (post/dynamic-resolution.ts) and the systems that scale
// their cost with it. Kept in core/ to avoid import cycles.
export const adaptive = {
  /** Current internal resolution scale. */
  scale: 0.6,
  /** Vsync-locked frame rate detected (the governor then only reacts to missed frames). */
  capped: false,
  /** Detail level in [0, 1] (1 = full): shortens forest/grass/rock detail distances when the resolution floor is
   *  reached and the frame budget is still exceeded. Changes slowly (transitions stay dithered and invisible). */
  quality: 1,
};

/** Interpolates a distance between its reduced (quality 0) and full value. */
export const qualityScaled = (full: number, minFactor: number) => full * (minFactor + (1 - minFactor) * adaptive.quality);
