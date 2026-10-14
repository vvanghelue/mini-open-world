// Keyboard / mouse state. Uses KeyboardEvent.code (physical keys), so WASD == ZQSD on AZERTY.

export class Input {
  readonly keys = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  buttons = 0;
  pointerLocked = false;
  /** When true, mouse movement is consumed only while the right button is held (editor style). */
  dragLook = true;
  private listeners = new Map<string, Set<() => void>>();

  constructor(private readonly element: HTMLElement) {
    const isTyping = (e: Event) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      if (!this.keys.has(e.code)) {
        this.pressed.add(e.code);
        this.listeners.get(e.code)?.forEach((fn) => fn());
      }
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.buttons = 0;
    });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    element.addEventListener('mousedown', (e) => {
      this.buttons = e.buttons;
    });
    window.addEventListener('mouseup', (e) => {
      this.buttons = e.buttons;
    });
    window.addEventListener('mousemove', (e) => {
      if (this.pointerLocked || (this.dragLook && e.buttons & 2)) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    element.addEventListener(
      'wheel',
      (e) => {
        this.wheel += Math.sign(e.deltaY);
        e.preventDefault();
      },
      { passive: false },
    );
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === element;
    });
  }

  requestPointerLock() {
    if (!this.pointerLocked) this.element.requestPointerLock?.();
  }

  exitPointerLock() {
    if (this.pointerLocked) document.exitPointerLock();
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  /** True only on the frame the key went down. */
  justPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  onKey(code: string, fn: () => void) {
    let s = this.listeners.get(code);
    if (!s) this.listeners.set(code, (s = new Set()));
    s.add(fn);
  }

  /** Call at the end of every frame. */
  endFrame() {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.pressed.clear();
  }
}
