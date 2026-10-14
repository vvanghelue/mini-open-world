// Vite dev-server plugin: bridge between CLI tools (tools/agent.mjs, tools/bench.mjs) and the running app.
//
//   app  <--WebSocket /__agent/ws-->  dev server  <--HTTP-->  CLI
//
// HTTP endpoints:
//   GET  /__agent/clients                 list connected app instances
//   POST /__agent/cmd   {cmd,args,client} forward a command to an app instance, wait for its reply
//   POST /__agent/write?path=rel/path     write the request body to a file (restricted directories)
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const WRITABLE = ['public/data/', 'world/', 'screenshots/', 'bench-results/', 'assets/'];

export function agentBridge() {
  return {
    name: 'agent-bridge',
    configureServer(server) {
      const root = server.config.root;
      const wss = new WebSocketServer({ noServer: true });
      const clients = new Map(); // id -> { ws, info, connectedAt }
      const pending = new Map(); // requestId -> { resolve, timer }
      let nextClient = 1;
      let nextReq = 1;

      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (req.url !== '/__agent/ws') return;
        wss.handleUpgrade(req, socket, head, (ws) => {
          const id = String(nextClient++);
          clients.set(id, { ws, info: {}, connectedAt: Date.now() });
          ws.on('message', (raw) => {
            let msg;
            try {
              msg = JSON.parse(raw.toString());
            } catch {
              return;
            }
            if (msg.type === 'hello') {
              clients.get(id).info = msg.info || {};
            } else if (msg.type === 'reply' && pending.has(msg.id)) {
              const p = pending.get(msg.id);
              pending.delete(msg.id);
              clearTimeout(p.timer);
              p.resolve(msg);
            } else if (msg.type === 'log') {
              server.config.logger.info(`[app ${id}] ${msg.text}`);
            }
          });
          ws.on('close', () => clients.delete(id));
        });
      });

      const readBody = (req) =>
        new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => resolve(Buffer.concat(chunks)));
          req.on('error', reject);
        });

      const send = (res, status, obj) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(obj));
      };

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/__agent/')) return next();
        const url = new URL(req.url, 'http://localhost');
        try {
          if (url.pathname === '/__agent/clients') {
            return send(res, 200, [...clients.entries()].map(([id, c]) => ({ id, ...c.info, connectedAt: c.connectedAt })));
          }
          if (url.pathname === '/__agent/cmd' && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)).toString() || '{}');
            let entry;
            if (body.client) entry = clients.get(String(body.client));
            else {
              // default: most recently connected client that is not a benchmark instance
              const list = [...clients.values()].sort((a, b) => b.connectedAt - a.connectedAt);
              entry = list.find((c) => !c.info.bench) || list[0];
            }
            if (!entry) return send(res, 503, { ok: false, error: 'no app connected (open http://localhost:5173 in Chrome)' });
            const id = nextReq++;
            const timeoutMs = body.timeout ?? 120000;
            const reply = await new Promise((resolve) => {
              const timer = setTimeout(() => {
                pending.delete(id);
                resolve({ ok: false, error: `timeout after ${timeoutMs} ms` });
              }, timeoutMs);
              pending.set(id, { resolve, timer });
              entry.ws.send(JSON.stringify({ type: 'cmd', id, cmd: body.cmd, args: body.args ?? {} }));
            });
            return send(res, 200, reply);
          }
          if (url.pathname === '/__agent/write' && req.method === 'POST') {
            const rel = path.normalize(url.searchParams.get('path') || '');
            if (rel.startsWith('..') || path.isAbsolute(rel) || !WRITABLE.some((p) => rel.startsWith(p))) {
              return send(res, 403, { ok: false, error: `path not writable: ${rel}` });
            }
            const abs = path.join(root, rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            const buf = await readBody(req);
            fs.writeFileSync(abs, buf);
            return send(res, 200, { ok: true, path: rel, bytes: buf.length });
          }
          send(res, 404, { ok: false, error: 'unknown agent endpoint' });
        } catch (err) {
          send(res, 500, { ok: false, error: String(err?.stack || err) });
        }
      });
    },
  };
}
