// Side panel generated from the settings schema (Tweakpane). Labels come from the settings schema.
import { Pane, FolderApi } from 'tweakpane';
import * as EssentialsPlugin from '@tweakpane/plugin-essentials';
import { settings, SettingDef } from '../core/settings';

export interface PanelAction {
  folder: string; // settings group id or a custom folder title
  label: string;
  run: () => void;
}

export class Panel {
  readonly pane: Pane;
  readonly element: HTMLElement;
  private folders = new Map<string, FolderApi>();
  private refreshQueued = false;

  constructor(actions: PanelAction[] = []) {
    this.element = document.createElement('div');
    this.element.id = 'panel';
    Object.assign(this.element.style, {
      position: 'fixed',
      top: '0',
      right: '0',
      width: '320px',
      maxHeight: '100vh',
      overflowY: 'auto',
      zIndex: '5',
      padding: '6px',
      boxSizing: 'border-box',
    } as CSSStyleDeclaration);
    document.body.appendChild(this.element);

    this.pane = new Pane({ container: this.element, title: 'World — settings (F1)' });
    this.pane.registerPlugin(EssentialsPlugin);

    for (const g of settings.groups.values()) {
      const folder = this.pane.addFolder({ title: g.title, expanded: g.expanded });
      this.folders.set(g.id, folder);
      for (const [key, def] of Object.entries(g.defs)) {
        if (def.hidden) continue;
        this.addBinding(folder, g.values, key, def, `${g.id}.${key}`);
      }
    }
    for (const a of actions) {
      const folder = this.folders.get(a.folder) ?? this.getOrCreateFolder(a.folder);
      folder.addButton({ title: a.label }).on('click', a.run);
    }

    // values changed from code / agent -> refresh the UI (coalesced to once per frame)
    settings.onAny(() => this.queueRefresh());

    window.addEventListener('keydown', (e) => {
      if (e.code === 'F1') {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  private getOrCreateFolder(title: string) {
    let f = this.folders.get(title);
    if (!f) {
      f = this.pane.addFolder({ title, expanded: false });
      this.folders.set(title, f);
    }
    return f;
  }

  private addBinding(folder: FolderApi, obj: Record<string, unknown>, key: string, def: SettingDef, path: string) {
    const params: Record<string, unknown> = { label: def.label ?? key };
    if (def.readonly) {
      folder.addBinding(obj, key, { ...params, readonly: true });
      return;
    }
    if (def.options) params.options = def.options;
    if (typeof def.value === 'number') {
      if (def.min !== undefined) params.min = def.min;
      if (def.max !== undefined) params.max = def.max;
      if (def.step !== undefined) params.step = def.step;
    }
    if (def.color) params.view = 'color';
    const b = folder.addBinding(obj, key, params);
    b.on('change', (ev) => {
      // Tweakpane already wrote the value into the settings object; notify listeners.
      settings.emit(path, ev.value as any);
    });
    if (def.help) (b.element as HTMLElement).title = def.help;
  }

  private queueRefresh() {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    requestAnimationFrame(() => {
      this.refreshQueued = false;
      this.pane.refresh();
    });
  }

  toggle(visible?: boolean) {
    const show = visible ?? this.element.style.display === 'none';
    this.element.style.display = show ? '' : 'none';
  }
}
