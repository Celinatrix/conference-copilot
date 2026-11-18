import { describe, expect, it } from 'vitest';
import { isAllowedOrigin } from '../src/config.js';

describe('LAN origins', () => {
  const lan = { allowedOrigins: ['http://localhost:3000'], allowLanOrigins: true };
  const local = { ...lan, allowLanOrigins: false };

  it('accepts private-network web app origins only in LAN mode', () => {
    for (const o of ['http://192.168.1.20:3000', 'http://10.0.0.5:3000', 'http://172.20.10.2:3000']) {
      expect(isAllowedOrigin(lan, o)).toBe(true);
      expect(isAllowedOrigin(local, o)).toBe(false);
    }
  });

  it('accepts the secure LAN mode origin (https on 3443) only in LAN mode', () => {
    for (const o of ['https://172.20.10.2:3443', 'https://192.168.1.20:3443']) {
      expect(isAllowedOrigin(lan, o)).toBe(true);
      expect(isAllowedOrigin(local, o)).toBe(false);
    }
  });

  it('rejects public hosts, other ports and look-alike hostnames even in LAN mode', () => {
    for (const o of [
      'http://8.8.8.8:3000',
      'https://8.8.8.8:3443',
      'http://172.32.0.1:3000',
      'http://192.168.1.20:4000',
      'https://192.168.1.20:3000',
      'http://192.168.1.20:3443',
      'http://192.168.1.20.evil.com:3000',
      'http://evil.com/?x=http://192.168.1.20:3000',
    ]) {
      expect(isAllowedOrigin(lan, o)).toBe(false);
    }
  });

  it('keeps the configured origins', () => {
    expect(isAllowedOrigin(local, 'http://localhost:3000')).toBe(true);
  });
});
