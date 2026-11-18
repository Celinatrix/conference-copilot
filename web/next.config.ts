import type { NextConfig } from 'next';

const apiOrigin = process.env.API_ORIGIN || 'http://127.0.0.1:4000';

const nextConfig: NextConfig = {
  // LAN mode (npm run dev:web:lan): a phone on the same Wi-Fi opens the app by this machine's private IP.
  allowedDevOrigins: ['192.168.*.*', '10.*.*.*', '172.*.*.*'],
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
