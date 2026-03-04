import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    base: './',                  // Required for Capacitor WebView (relative asset paths)
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    optimizeDeps: {
      exclude: ['@capacitor-community/sqlite'],
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
