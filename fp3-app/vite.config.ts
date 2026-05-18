import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/fp3-dopamine-study/',
  plugins: [react()],
});
