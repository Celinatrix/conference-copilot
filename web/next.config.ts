import type { NextConfig } from 'next';
import os from 'node:os';

const apiOrigin = process.env.API_ORIGIN || 'http://127.0.0.1:4000';

/**
 * LAN mode (npm run dev:web:lan): a phone opens the app by this machine's private IP. Next's wildcard patterns do not
 * match numeric IPs, so the exact addresses are listed: this machine's current IPv4 addresses (read at start-up) and
 * every address an iPhone hotspot can hand out (172.20.10.1-15), so switching to the hotspot needs no restart.
 */
const lanHosts = [
  ...Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address),
  ...Array.from({ length: 15 }, (_, i) => `172.20.10.${i + 1}`),
];

const nextConfig: NextConfig = {
  allowedDevOrigins: [...new Set(lanHosts)],
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
