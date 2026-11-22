# Codex Mobile Companion

An unofficial, self-hosted Windows companion for accessing your own Codex desktop sessions from a phone browser. The intended deployment uses a private Tailscale connection, with the gateway on your PC rather than on GitHub or a shared server.

## Development status

This is a **source preview**, not an installer or a runnable remote-control service. It includes the mobile UI, its private page handler, and modules for access checks, conversation history snapshots, and operation receipts. The gateway, desktop adapter, and Windows launcher are not yet included. Cloning this repository will not start a gateway or connect to Codex.

The first runnable release is intended to cover session browsing, history, sending messages, and approvals. Notifications are not required for the first-run setup. Windows and Codex version support will be listed after a clean-machine test.

## Run the module checks

Use Node.js 24 or later. The checks require no dependencies, credentials, network calls, or running Codex instance.

```sh
npm test
```

The GitHub Actions workflow runs the same checks on Windows and Linux. Passing module checks does not establish that a Codex desktop version is supported.

The optional browser fixture uses Playwright and Chromium. With Playwright available on Node's module path and its browser installed, run `node test/browser-mobile.cjs`. Set `PLAYWRIGHT_CHANNEL=msedge` to use an installed Microsoft Edge. The fixture verifies the mobile page at 320, 390, and 1280 px against synthetic responses; it does not connect to Codex.

## Security boundary

The preview access module assumes a trusted, loopback-only proxy. It is not a standalone authentication server. Do not expose a gateway or an Electron debugging port to the public internet. Do not include credentials, private links, real sessions, or runtime logs in issue reports.

No third-party application binaries, extracted application assets, or user runtime data are included. Distribution terms for the source must be settled before public release.
