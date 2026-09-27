import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// The simulator's web UI, served by the control port (src/control-api/app.ts)
// from dist/web. `npm run dev:web` proxies the API to a local simulator.
export default defineConfig({
  root: resolve(__dirname),
  plugins: [svelte()],
  build: { outDir: resolve(__dirname, '../dist/web'), emptyOutDir: true },
  server: { proxy: { '/sim': 'http://localhost:9443' } },
});
