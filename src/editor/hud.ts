// Small performance / status overlay (top-left). Updated 4x per second, no per-frame DOM work.
import { Vector2 } from 'three/webgpu';
import type { Engine } from '../core/engine';
import { renderSettings } from '../core/engine';

const _size = new Vector2();

export class Hud {
  readonly element: HTMLElement;
  private last = 0;
  /** Extra status lines provided by systems (mode, altitude, time of day...). */
  readonly lines = new Map<string, () => string>();

  constructor(private engine: Engine) {
    this.element = document.createElement('div');
    this.element.id = 'hud';
    Object.assign(this.element.style, {
      position: 'fixed',
      top: '8px',
      left: '8px',
      zIndex: '5',
      font: '11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace',
      color: '#e8f0f8',
      background: 'rgba(10,14,20,0.55)',
      padding: '6px 8px',
      borderRadius: '4px',
      whiteSpace: 'pre',
      pointerEvents: 'none',
    } as CSSStyleDeclaration);
    document.body.appendChild(this.element);
  }

  update(now: number) {
    if (now - this.last < 250) return;
    this.last = now;
    const s = this.engine.stats.summary();
    this.engine.renderer.getDrawingBufferSize(_size);
    const sc = renderSettings.resolutionScale;
    const lines = [
      `${s.fps.toFixed(0).padStart(4)} fps   frame ${s.intervalMs.mean.toFixed(2)} ms (p99 ${s.intervalMs.p99.toFixed(1)})`,
      `CPU ${s.cpuMs.mean.toFixed(2)} ms   GPU ${s.gpuMs ? s.gpuMs.mean.toFixed(2) + ' ms' : 'n/a'}`,
      `draws ${s.drawCalls}   tris ${(s.triangles / 1e6).toFixed(2)} M   compute ${s.computeCalls}`,
      `sortie ${_size.x}x${_size.y}   interne ${Math.round(_size.x * sc)}x${Math.round(_size.y * sc)}`,
    ];
    for (const fn of this.lines.values()) lines.push(fn());
    this.element.textContent = lines.join('\n');
  }
}
