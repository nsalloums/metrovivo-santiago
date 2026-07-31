import { defineConfig } from 'vite';

// BASE_PATH permite servir bajo un subdirectorio (GitHub Pages: "/metrovivo/").
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  build: {
    outDir: 'dist',
    target: 'es2020',
    rollupOptions: {
      output: {
        // three.js es ~80 % del bundle y cambia solo al actualizar la
        // dependencia: en su propio chunk sobrevive al caché entre deploys.
        manualChunks: { three: ['three'] },
      },
    },
  },
});
