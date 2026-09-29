import { defineConfig, loadEnv } from 'vite';
import { roomServerPlugin } from './server/rooms.js';

export default defineConfig(({ mode }) => ({
  // host: true → friends on the same Wi-Fi can open the "Network" address that npm run dev prints
  server: { port: 5173, open: true, host: true },
  preview: { host: true },
  // multiplayer room codes while developing (on Vercel: api/room.js). Relay (TURN) keys go in .env.local
  plugins: [roomServerPlugin({ ...process.env, ...loadEnv(mode, process.cwd(), '') })],
  build: { chunkSizeWarningLimit: 1200 },
}));