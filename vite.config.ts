import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom'],
            motion: ['motion/react'],
          },
        },
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      // Only the frontend reloads the page: editing a script, the API or the docs must not
      // reload pages under test.
      watch: { ignored: ['**/scripts/**', '**/server/**', '**/docs/**', '**/samples/**'] },
      proxy: {
        '/api': {
          // API_PROXY_TARGET: another local API, e.g. a second one with live Gemini.
          target: process.env.API_PROXY_TARGET || 'http://localhost:3001',
          changeOrigin: true
        }
      }
    },
  };
});
