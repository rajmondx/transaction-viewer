import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Fully static site (GitHub Pages under /<repo>/): relative base, no API proxy.
export default defineConfig({
  plugins: [tailwindcss()],
  base: './',
});
