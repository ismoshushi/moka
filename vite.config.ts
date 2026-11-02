import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Electron 用 file:// 加载打包产物，必须用相对路径
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5273, strictPort: true },
})
