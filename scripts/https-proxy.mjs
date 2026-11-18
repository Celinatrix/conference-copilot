// Secure LAN mode: wraps the running dev servers in HTTPS so an iPhone on the same network (e.g. connected
// by USB Personal Hotspot) is allowed to use its microphone. Browsers only grant microphone access to
// https:// pages (or localhost), so plain LAN mode lets a phone listen but not record.
//
//   https://<laptop-ip>:3443  -> web app   (http://127.0.0.1:3000)
//   https://<laptop-ip>:4443  -> API + WebSocket (http://127.0.0.1:4000)
//   http://<laptop-ip>:3080   -> page to install the certificate on the phone (once)
//
// Run after `npm run dev:server:lan` and `npm run dev:web:lan`:  npm run dev:https
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'certs');
const PAIRS = [
  [3443, 3000],
  [4443, 4000],
];
const CA_PORT = 3080;
const CA_NAME = 'Conference Copilot Local CA';

function findOpenssl() {
  const candidates = [
    'openssl',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\mingw64\\bin\\openssl.exe',
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ['version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* try the next one */
    }
  }
  throw new Error('Không tìm thấy openssl. Cài Git for Windows (có kèm openssl) rồi chạy lại.');
}

function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function ensureCerts() {
  mkdirSync(DIR, { recursive: true });
  const openssl = findOpenssl();
  const run = (args) => execFileSync(openssl, args, { cwd: DIR, stdio: ['ignore', 'ignore', 'pipe'] });
  const ca = path.join(DIR, 'ca.crt');

  // The CA is created once and kept: the phone trusts it once, and every later server certificate inherits that trust.
  if (!existsSync(ca) || !existsSync(path.join(DIR, 'ca.key'))) {
    console.log('Tạo chứng chỉ gốc (CA) mới…');
    run(['req', '-x509', '-new', '-nodes', '-newkey', 'rsa:2048', '-sha256', '-days', '825', '-keyout', 'ca.key', '-out', 'ca.crt',
      '-subj', `/CN=${CA_NAME}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  }

  // iPhone USB / Wi-Fi hotspot hands out 172.20.10.1-14, so all of them are included: the address can change between sessions.
  const ips = [...new Set(['127.0.0.1', ...lanIps(), ...Array.from({ length: 15 }, (_, i) => `172.20.10.${i + 1}`)])];
  const san = ['DNS:localhost', ...ips.map((ip) => `IP:${ip}`)].join(',');
  const sanFile = path.join(DIR, 'server.san');
  const current = existsSync(sanFile) ? readFileSync(sanFile, 'utf8') : '';
  if (current !== san || !existsSync(path.join(DIR, 'server.crt'))) {
    console.log('Tạo chứng chỉ cho các địa chỉ hiện tại của laptop…');
    // Apple requires: SAN, serverAuth, validity of at most 825 days (397 keeps it under every current limit).
    writeFileSync(path.join(DIR, 'server.ext'), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n`);
    run(['req', '-new', '-nodes', '-newkey', 'rsa:2048', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=Conference Copilot']);
    run(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '397', '-sha256', '-extfile', 'server.ext']);
    writeFileSync(sanFile, san);
  }
  return { key: readFileSync(path.join(DIR, 'server.key')), cert: readFileSync(path.join(DIR, 'server.crt')), ca: readFileSync(ca) };
}

/** TLS in front, plain TCP to the dev server behind: carries HTTP, streaming responses and WebSocket upgrades alike. */
function startTunnel(creds, listenPort, targetPort) {
  const server = tls.createServer({ key: creds.key, cert: creds.cert }, (client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', close);
    upstream.on('error', close);
    client.pipe(upstream).pipe(client);
  });
  server.on('tlsClientError', () => {}); // phone not trusting the certificate yet: nothing to do here
  server.listen(listenPort, '0.0.0.0');
  return server;
}

const PAGE = (ips) => `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cài chứng chỉ</title><style>body{font:17px/1.6 -apple-system,system-ui,sans-serif;margin:0;background:#05080f;color:#e8edf7}main{max-width:560px;margin:0 auto;padding:20px 16px}
a.btn{display:block;text-align:center;background:#3b6cff;color:#fff;padding:14px;border-radius:12px;text-decoration:none;font-weight:600;margin:16px 0}
ol{padding-left:22px}li{margin:8px 0}code{background:#0d1424;padding:2px 6px;border-radius:6px}.muted{color:#9aa6bd;font-size:15px}</style></head><body><main>
<h1>Cài chứng chỉ cho iPhone</h1>
<p class="muted">Chỉ cần làm một lần. Sau đó iPhone mở app qua HTTPS và được phép dùng micro.</p>
<a class="btn" href="/copilot-ca.crt">1. Tải chứng chỉ</a>
<ol>
<li>Bấm nút trên, chọn <b>Cho phép</b>.</li>
<li>Mở <b>Cài đặt</b> → <b>Đã tải về hồ sơ</b> (ngay dưới tên bạn) → <b>Cài đặt</b> → nhập mật mã → <b>Cài đặt</b>.</li>
<li><b>Cài đặt</b> → <b>Cài đặt chung</b> → <b>Giới thiệu</b> → kéo xuống cuối → <b>Cài đặt tin cậy chứng nhận</b> → bật <b>${CA_NAME}</b>.</li>
<li>Mở Safari tới địa chỉ app:<br>${ips.map((ip) => `<code>https://${ip}:3443</code>`).join('<br>')}</li>
</ol>
<p class="muted">Chứng chỉ chỉ dùng cho laptop của bạn trong mạng nội bộ. Muốn gỡ: Cài đặt → Cài đặt chung → VPN &amp; Quản lý thiết bị.</p>
</main></body></html>`;

const creds = ensureCerts();
for (const [listen, target] of PAIRS) startTunnel(creds, listen, target);
http
  .createServer((req, res) => {
    if (req.url === '/copilot-ca.crt') {
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="copilot-ca.crt"' });
      res.end(creds.ca);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE(lanIps()));
  })
  .listen(CA_PORT, '0.0.0.0');

const ips = lanIps();
console.log('\nChế độ HTTPS đang chạy (Ctrl+C để dừng).');
console.log('Cần chạy kèm: npm run dev:server:lan  và  npm run dev:web:lan\n');
for (const ip of ips) {
  console.log(`  Cài chứng chỉ (một lần):  http://${ip}:${CA_PORT}`);
  console.log(`  Mở app trên iPhone:       https://${ip}:3443\n`);
}
