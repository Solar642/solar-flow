import { defineConfig } from 'vite';

export default defineConfig({
  base: '/solar-flow/',
  build: {
    assetsDir: '.',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/xlsx/')) return 'xlsx';
        }
      }
    }
  }
});
