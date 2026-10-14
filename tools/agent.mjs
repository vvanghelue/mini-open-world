#!/usr/bin/env node
// CLI to drive the running app through the dev-server bridge.
//
//   node tools/agent.mjs help                       list app commands
//   node tools/agent.mjs <cmd> '{"json":"args"}'     run a command with JSON args
//   node tools/agent.mjs <cmd> key=value key2=value  run a command with simple args (numbers/bools parsed)
//   node tools/agent.mjs clients                    list connected app instances
//
// Options: --client=<id>  target a specific app instance; --timeout=<ms>; --url=http://localhost:5173
const argv = process.argv.slice(2);
const opts = {};
const pos = [];
for (const a of argv) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) opts[m[1]] = m[2];
  else pos.push(a);
}
const base = opts.url || process.env.AGENT_URL || 'http://localhost:5173';

function parseValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  if ((v.startsWith('[') || v.startsWith('{')) && v.length > 1) {
    try {
      return JSON.parse(v);
    } catch {}
  }
  return v;
}

async function main() {
  const cmd = pos[0] || 'help';
  if (cmd === 'clients') {
    const res = await fetch(`${base}/__agent/clients`);
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }
  let args = {};
  const rest = pos.slice(1);
  if (rest.length === 1 && (rest[0].startsWith('{') || rest[0].startsWith('['))) args = JSON.parse(rest[0]);
  else
    for (const r of rest) {
      const i = r.indexOf('=');
      if (i > 0) args[r.slice(0, i)] = parseValue(r.slice(i + 1));
      else (args._ ||= []).push(parseValue(r));
    }
  const res = await fetch(`${base}/__agent/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd, args, client: opts.client, timeout: opts.timeout ? Number(opts.timeout) : undefined }),
  });
  const json = await res.json();
  if (!json.ok) {
    console.error('ERROR:', json.error);
    process.exit(1);
  }
  const r = json.result;
  console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2));
}

main().catch((e) => {
  console.error(e.cause?.code === 'ECONNREFUSED' ? `dev server not running at ${base} (npm run dev)` : e);
  process.exit(1);
});
