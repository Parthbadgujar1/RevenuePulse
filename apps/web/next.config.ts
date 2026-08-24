import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // pdf-parse -> pdfjs-dist resolves its worker via dynamic import at
  // runtime; bundling it breaks. Load these natively in the Node server.
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist'],
};

export default nextConfig;
