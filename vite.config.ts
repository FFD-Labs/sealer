import { defineConfig } from 'vite'

export default defineConfig({ root: 'web', base: './', build: { outDir: '../dist', emptyOutDir: true, rollupOptions: { input: 'web/p.html' } } })
