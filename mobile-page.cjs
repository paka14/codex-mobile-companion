'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { renderMobile, trustedTailscale } = require('./mobile-access.cjs');

function createMobilePage(access) {
  const html = readFileSync(join(__dirname, 'public', 'mobile.html'), 'utf8');
  const assets = new Map(['mobile-controls.js', 'mobile-diagnostics.js', 'mobile-diagnostics-sw.js', 'mobile-diagnostics-offline.html']
    .map(name => ['/' + name, readFileSync(join(__dirname, 'public', name))]));
  const hash = createHash('sha256').update(html);
  for (const body of assets.values()) hash.update(body);
  const version = hash.digest('hex').slice(0, 12);
  const page = renderMobile(html, version, true);

  return (req, res) => {
    const path = req.url.split('?')[0];
    if (path !== '/mobile' && !assets.has(path)) return false;

    const headers = {
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, Allow: 'GET, HEAD' }).end();
    } else if (!trustedTailscale(req, access)) {
      res.writeHead(403, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' })
        .end(req.method === 'HEAD' ? undefined : 'Connect to Tailscale and open the private companion URL.');
    } else {
      const isPage = path === '/mobile';
      res.writeHead(200, { ...headers,
        'Content-Type': isPage || path.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
        ...(path === '/mobile-diagnostics-sw.js' ? { 'Service-Worker-Allowed': '/mobile' } : {}),
      }).end(req.method === 'HEAD' ? undefined : isPage ? page : assets.get(path));
    }
    return true;
  };
}

module.exports = { createMobilePage };
