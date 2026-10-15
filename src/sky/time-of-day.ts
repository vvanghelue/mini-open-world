// Time of day / date clock and the resulting sun & moon directions.
import { Vector3 } from 'three/webgpu';
import type { System, FrameContext } from '../core/engine';
import { settings } from '../core/settings';
import { sunDirection, moonDirection } from './sun';

export const timeSettings = settings.group(
  'time',
  'Time & date',
  {
    hour: { value: 10.5, min: 0, max: 24, step: 0.01, label: 'Hour' },
    day: { value: 196, min: 1, max: 365, step: 1, label: 'Day of year' },
    speed: { value: 30, min: 0, max: 3600, step: 1, label: 'Speed (x real time)', help: '60 = one game minute per second; 0 = frozen' },
    year: { value: 2026, min: 2000, max: 2100, step: 1, label: 'Year', hidden: true },
  },
  true,
);

export class TimeOfDay implements System {
  readonly name = 'time';
  readonly sunDir = new Vector3(0, 1, 0);
  readonly moonDir = new Vector3(0, -1, 0);
  moonPhase = 0.5;
  /** Incremented whenever the sun moved noticeably (consumers re-bake lighting). */
  sunVersion = 0;
  private lastSun = new Vector3();
  private lastHour = -1;
  /** Change of the clock since last frame (hours); large values mean a manual jump. */
  hourDelta = 0;

  update(ctx: FrameContext) {
    if (timeSettings.speed > 0 && ctx.dt > 0) {
      let h = timeSettings.hour + (ctx.dt * timeSettings.speed) / 3600;
      if (h >= 24) {
        h -= 24;
        timeSettings.day = (timeSettings.day % 365) + 1;
      }
      timeSettings.hour = h;
    }
    this.hourDelta = this.lastHour < 0 ? 0 : timeSettings.hour - this.lastHour;
    if (this.hourDelta < -12) this.hourDelta += 24;
    this.lastHour = timeSettings.hour;
    sunDirection(timeSettings.year, timeSettings.day, timeSettings.hour, this.sunDir);
    this.moonPhase = moonDirection(timeSettings.year, timeSettings.day, timeSettings.hour, this.moonDir);
    if (this.sunDir.dot(this.lastSun) < Math.cos(0.05 * Math.PI / 180)) {
      this.lastSun.copy(this.sunDir);
      this.sunVersion++;
    }
  }

  /** Hour as HH:MM. */
  label() {
    const h = Math.floor(timeSettings.hour);
    const m = Math.floor((timeSettings.hour - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
