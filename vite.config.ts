import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      // Proxy API requests to backend server (localhost:8092)
      '/share-nest': {
        target: 'http://localhost:8092',
        changeOrigin: true,
        secure: false,
      },
      // Proxy WebSocket connections to WebSocket server (localhost:1234)
      '/webrtc': {
        target: 'ws://localhost:1234',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
