import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1' },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Keep each reporting library's initialization dependencies together.
          groups: [
            { name: 'export-pdf', test: /[\\/]node_modules[\\/]jspdf(?:-autotable)?[\\/]/ },
            { name: 'export-word', test: /[\\/]node_modules[\\/]docx[\\/]/ },
            { name: 'export-excel', test: /[\\/]node_modules[\\/]exceljs[\\/]/ },
          ],
        },
      },
    },
  },
})
