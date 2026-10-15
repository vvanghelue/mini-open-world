#!/usr/bin/env node
// Opens the app in a separate Chrome instance without the vsync / frame-rate cap, so the HUD shows the frame rate
// the machine can actually sustain (a MacBook Air display is 60 Hz: a normal browser never shows more than 60 fps).
// Uses its own profile directory (.chrome-uncapped/, git-ignored): the flags only apply to a new browser process.
//   npm run uncapped            (dev server must be running: npm run dev)
//   node tools/open-uncapped.mjs [--url=http://localhost:5173]
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const url = (process.argv.find((a) => a.startsWith('--url=')) || '--url=http://localhost:5173').slice(6);
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const child = spawn(chrome, [
  `--user-data-dir=${path.join(ROOT, '.chrome-uncapped')}`,
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
  '--no-first-run',
  '--no-default-browser-check',
  '--new-window',
  url,
], { detached: true, stdio: 'ignore' });
child.unref();
console.log(`Chrome (uncapped) -> ${url}`);
