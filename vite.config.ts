import fs from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
// @ts-ignore - plain JS plugin
import { agentBridge } from './tools/vite-agent-plugin.mjs';

// Static build: ship the saved world (settings, placed objects) next to the page.
function worldFiles(): Plugin {
  return {
    name: 'world-files',
    apply: 'build',
    generateBundle() {
      for (const f of ['settings.json', 'props.json']) {
        this.emitFile({ type: 'asset', fileName: `world/${f}`, source: fs.readFileSync(`world/${f}`, 'utf8') });
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  // GitHub Pages serves the demo from /<repo>/ (set by the deploy workflow)
  base: process.env.BASE_PATH ?? '/',
  plugins: [agentBridge(), worldFiles()],
  // public/data (600 MB of raw data) is not copied by the build: tools/data/pack-web.mjs writes a packed copy to dist/data
  publicDir: command === 'build' ? false : 'public',
  server: {
    port: 5173,
    strictPort: true,
    // public/data is watched so newly generated data files are served without a restart
    watch: { ignored: ['**/data-raw/**', '**/screenshots/**', '**/screenshots.noindex/**', '**/bench-results/**'] },
  },
  build: { target: 'es2022' },
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
}));
