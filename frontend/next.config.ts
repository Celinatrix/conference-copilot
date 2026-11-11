import type { NextConfig } from 'next';

const apiOrigin = process.env.API_ORIGIN || 'http://127.0.0.1:4000';

const nextConfig: NextConfig = {
  experimental: {
    // /api requests are proxied to the backend, and Next.js buffers a proxied body only up to 10 MB by default:
    // larger document uploads arrived truncated and failed. The backend accepts files up to 25 MB (MAX_UPLOAD_BYTES);
    // 26 MB leaves room for the multipart envelope.
    proxyClientMaxBodySize: '26mb',
  },
  // The browser only talks to this origin for REST, so the session cookie stays first-party.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'microphone=(self), display-capture=(self), camera=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
