import type { Engine } from './core/engine';
import type { Input } from './core/input';
import type { Terrain } from './terrain/terrain';
import type { FreeCamera } from './player/free-camera';
import type { Panel } from './editor/panel';
import type { Hud } from './editor/hud';

/** Global application context (also exposed as window.app for the agent's eval command). */
export interface App {
  engine: Engine;
  input: Input;
  terrain: Terrain;
  freeCam: FreeCamera;
  panel: Panel;
  hud: Hud;
  [key: string]: unknown;
}
