// App side of the agent bridge (see tools/vite-agent-plugin.mjs). Commands are registered by systems and
// invoked from the CLI: `npm run agent -- <cmd> [json args]`.

export type CommandFn = (args: any) => unknown | Promise<unknown>;

interface CommandEntry {
  help: string;
  fn: CommandFn;
}

const commands = new Map<string, CommandEntry>();
const logBuffer: Array<{ t: number; level: string; text: string }> = [];

export function registerCommand(name: string, help: string, fn: CommandFn) {
  commands.set(name, { help, fn });
}

export function listCommands() {
  return [...commands.entries()].map(([name, c]) => ({ name, help: c.help })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function runCommand(name: string, args: any) {
  const c = commands.get(name);
  if (!c) throw new Error(`unknown command "${name}" (try "help")`);
  return await c.fn(args ?? {});
}

export function getLogs(since = 0) {
  return logBuffer.filter((l) => l.t > since);
}

function captureConsole() {
  const push = (level: string, args: unknown[]) => {
    const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : safeJson(a))).join(' ');
    logBuffer.push({ t: Date.now(), level, text: text.slice(0, 4000) });
    if (logBuffer.length > 500) logBuffer.splice(0, logBuffer.length - 500);
  };
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(level, args);
      orig(...args);
    };
  }
  window.addEventListener('error', (e) => push('error', [e.error || e.message]));
  window.addEventListener('unhandledrejection', (e) => push('error', ['unhandled rejection', e.reason]));
}

function safeJson(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export async function writeProjectFile(relPath: string, data: Blob | ArrayBuffer | ArrayBufferView | string) {
  if (!import.meta.env.DEV) throw new Error('file writes need the dev server (npm run dev)');
  const res = await fetch(`/__agent/write?path=${encodeURIComponent(relPath)}`, { method: 'POST', body: data as BodyInit });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error);
  return json;
}

export function startBridge(info: Record<string, unknown>) {
  captureConsole();
  (window as any).agent = { run: runCommand, list: listCommands, logs: getLogs };
  if (!import.meta.env.DEV) return; // static build: no dev server to connect to (commands stay usable from the console)
  let ws: WebSocket | null = null;
  let retry = 500;
  const connect = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/__agent/ws`);
    ws.onopen = () => {
      retry = 500;
      ws!.send(JSON.stringify({ type: 'hello', info }));
    };
    ws.onmessage = async (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type !== 'cmd') return;
      let reply: any;
      try {
        const result = await runCommand(msg.cmd, msg.args);
        reply = { type: 'reply', id: msg.id, ok: true, result };
      } catch (err: any) {
        reply = { type: 'reply', id: msg.id, ok: false, error: String(err?.stack || err) };
      }
      ws?.send(JSON.stringify(reply, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)));
    };
    ws.onclose = () => {
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 5000);
    };
  };
  connect();
}
