import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  // Turbopack root: Next.js sometimes warns about multiple lockfiles
  // when the project root contains multiple workspaces. Setting `turbopack.root`
  // silences the warning and fixes the IDE / build output in CI.
  turbopack: { root: path.resolve(__dirname, '..') },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'cdn.spectrumdevs.com',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
