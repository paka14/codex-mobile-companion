'use strict';

const { readFile } = require('node:fs/promises');
const { dirname, resolve } = require('node:path');
const { createGateway } = require('./gateway.cjs');
const { createDesktopAdapter } = require('./desktop-adapter.cjs');

async function loadConfig(file) {
  const config = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  const { origin, ownerLogin, dataDirectory = 'data', port = 4317, desktopPort = 9229 } = config ?? {};
  const boundPort = value => Number.isInteger(value) && value >= 1024 && value <= 65535;
  const url = URL.canParse(origin) ? new URL(origin) : null;
  if (!url || url.protocol !== 'https:' || url.origin !== origin || url.port ||
      typeof ownerLogin !== 'string' || !/^[\x21-\x7e]{1,254}$/.test(ownerLogin) ||
      typeof dataDirectory !== 'string' || !dataDirectory.trim() ||
      !boundPort(port) || !boundPort(desktopPort) || port === desktopPort) {
    throw Error('Invalid HTTPS origin, owner login, data directory or ports.');
  }
  return { origin, ownerLogin, dataDirectory: resolve(dirname(file), dataDirectory), port, desktopPort };
}

async function startCompanion(config, { makeDesktop = createDesktopAdapter } = {}) {
  const desktop = makeDesktop({ port: config.desktopPort });
  const gateway = createGateway({
    ...config, desktop,
    reportError() { console.error('A companion request failed. Check the Codex desktop connection.'); },
  });
  const address = await gateway.start(config.port);
  try { desktop.start(); }
  catch (error) { await gateway.close(); throw error; }
  let closing;
  return {
    address,
    close: () => closing ??= gateway.close().finally(() => desktop.stop()),
  };
}

async function main(args) {
  const check = args[0] === '--check-config';
  if (args.length !== (check ? 2 : 1)) throw Error('Usage: node companion.cjs [--check-config] <configuration.json>');
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Node.js 24 or later is required.');
  let config;
  try { config = await loadConfig(resolve(args[check ? 1 : 0])); }
  catch { throw Error('Could not read configuration. Check the JSON file and the documented settings.'); }
  if (check) {
    console.log(JSON.stringify({ port: config.port, desktopPort: config.desktopPort }));
    return;
  }
  const companion = await startCompanion(config);
  console.log('Codex Mobile Companion listening on 127.0.0.1:' + companion.address.port);
  const stop = () => void companion.close().catch(() => { process.exitCode = 1; });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.code === 'EADDRINUSE' ? 'Companion port is already in use.' : error.message);
  process.exitCode = 1;
});
module.exports = { loadConfig, startCompanion };
