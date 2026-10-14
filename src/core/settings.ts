// Central, schema-driven settings store.
// - Systems declare their tunables with `settings.group(...)` and read live values from the returned object.
// - The side panel is generated from the schema; the agent bridge reads/writes values by dotted path.
// - Values can be saved to / loaded from world/settings.json.

export type SettingValue = number | boolean | string;

export interface SettingDef<T extends SettingValue = SettingValue> {
  value: T;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Record<string, T>; // label -> value
  color?: boolean; // string value is a '#rrggbb' color
  readonly?: boolean;
  hidden?: boolean; // not shown in panel
  help?: string;
}

type Defs = Record<string, SettingDef>;
type Values<D extends Defs> = { -readonly [K in keyof D]: D[K]['value'] };

export interface SettingsGroup {
  id: string;
  title: string;
  defs: Defs;
  values: Record<string, SettingValue>;
  expanded: boolean;
}

type Listener = (value: SettingValue, path: string) => void;

class Settings {
  readonly groups = new Map<string, SettingsGroup>();
  private listeners = new Map<string, Set<Listener>>();
  private anyListeners = new Set<Listener>();
  private pending: Record<string, SettingValue> = {};

  group<D extends Defs>(id: string, title: string, defs: D, expanded = false): Values<D> {
    let g = this.groups.get(id);
    if (!g) {
      g = { id, title, defs: {}, values: {}, expanded };
      this.groups.set(id, g);
    }
    for (const [key, def] of Object.entries(defs)) {
      g.defs[key] = def;
      const path = `${id}.${key}`;
      g.values[key] = path in this.pending ? coerce(this.pending[path], def) : def.value;
      delete this.pending[path];
    }
    return g.values as Values<D>;
  }

  has(path: string): boolean {
    const [gid, key] = split(path);
    return !!this.groups.get(gid)?.defs[key];
  }

  get(path: string): SettingValue | undefined {
    const [gid, key] = split(path);
    return this.groups.get(gid)?.values[key];
  }

  set(path: string, value: SettingValue, silent = false): boolean {
    const [gid, key] = split(path);
    const g = this.groups.get(gid);
    if (!g || !(key in g.defs)) {
      this.pending[path] = value; // group may be declared later (lazy systems)
      return false;
    }
    const v = coerce(value, g.defs[key]);
    if (g.values[key] === v) return true;
    g.values[key] = v;
    if (!silent) this.emit(path, v);
    return true;
  }

  /** Notify listeners after the panel mutated a value in place. */
  emit(path: string, value: SettingValue) {
    this.listeners.get(path)?.forEach((l) => l(value, path));
    this.anyListeners.forEach((l) => l(value, path));
  }

  on(path: string, fn: Listener, fireNow = false): () => void {
    let set = this.listeners.get(path);
    if (!set) this.listeners.set(path, (set = new Set()));
    set.add(fn);
    if (fireNow) {
      const v = this.get(path);
      if (v !== undefined) fn(v, path);
    }
    return () => set!.delete(fn);
  }

  onAny(fn: Listener): () => void {
    this.anyListeners.add(fn);
    return () => this.anyListeners.delete(fn);
  }

  /** Flat snapshot of all values: { 'group.key': value }. */
  snapshot(includeDefaults = true): Record<string, SettingValue> {
    const out: Record<string, SettingValue> = {};
    for (const g of this.groups.values()) {
      for (const [k, v] of Object.entries(g.values)) {
        if (g.defs[k].readonly) continue;
        if (!includeDefaults && g.defs[k].value === v) continue;
        out[`${g.id}.${k}`] = v;
      }
    }
    return { ...this.pending, ...out };
  }

  /** Schema description, used by the agent to discover tunables. */
  describe(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const g of this.groups.values()) {
      for (const [k, d] of Object.entries(g.defs)) {
        out[`${g.id}.${k}`] = { value: g.values[k], default: d.value, min: d.min, max: d.max, options: d.options, label: d.label, help: d.help };
      }
    }
    return out;
  }

  load(values: Record<string, SettingValue>) {
    for (const [path, v] of Object.entries(values)) this.set(path, v);
  }
}

function split(path: string): [string, string] {
  const i = path.indexOf('.');
  return i < 0 ? [path, ''] : [path.slice(0, i), path.slice(i + 1)];
}

function coerce(value: SettingValue, def: SettingDef): SettingValue {
  if (typeof def.value === 'number') {
    let n = typeof value === 'number' ? value : parseFloat(String(value));
    if (!Number.isFinite(n)) n = def.value;
    if (def.min !== undefined) n = Math.max(def.min, n);
    if (def.max !== undefined) n = Math.min(def.max, n);
    return n;
  }
  if (typeof def.value === 'boolean') return value === true || value === 'true' || value === 1;
  return String(value);
}

export const settings = new Settings();
