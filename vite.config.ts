import { defineConfig } from 'vite';
// @ts-ignore - plain JS plugin
import { agentBridge } from './tools/vite-agent-plugin.mjs';

export default defineConfig({
  plugins: [agentBridge()],
  server: {
    port: 5173,
    strictPort: true,
    // public/data is watched so newly generated data files are served without a restart
    watch: { ignored: ['**/data-raw/**', '**/screenshots/**', '**/screenshots.noindex/**', '**/bench-results/**'] },
  },
  build: { target: 'es2022' },
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
});
