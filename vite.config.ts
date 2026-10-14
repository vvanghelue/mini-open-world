import { defineConfig } from 'vite';
// @ts-ignore - plain JS plugin
import { agentBridge } from './tools/vite-agent-plugin.mjs';

export default defineConfig({
  plugins: [agentBridge()],
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/data-raw/**', '**/public/data/**', '**/screenshots/**', '**/bench-results/**'] },
  },
  build: { target: 'es2022' },
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
});
