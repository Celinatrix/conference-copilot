import type { NextConfig } from 'next';

const apiOrigin = process.env.API_ORIGIN || 'http://127.0.0.1:4000';

const nextConfig: NextConfig = {
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
