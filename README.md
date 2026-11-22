# Codex Mobile Companion

An unofficial, self-hosted Windows companion for accessing your own Codex desktop sessions from a phone browser. The intended deployment uses a private Tailscale connection, with the gateway on your PC rather than on GitHub or a shared server.

## Development status

This is a **developer preview**, not an installer. The mobile UI, loopback gateway and local Codex bridge run together. The Windows desktop launcher and real-phone verification are still pending. No desktop version is advertised as supported yet. Read and pin state are not synced to the desktop sidebar in this preview.

The first runnable release is intended to cover session browsing, history, sending messages, and approvals. Notifications are not required for the first-run setup. Windows and Codex version support will be listed after a clean-machine test.

## Start the gateway

Requires Node.js 24 or later. Save a local configuration as `companion.config.json` (ignored by Git), or keep it outside this checkout. Replace the example origin with the exact HTTPS origin reported by your own [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) instance; do not include a trailing slash. Set the login to the exact identity of the phone user. Keep the example ports unless the gateway or local debugger already uses a different port.

```json
{
  "origin": "https://companion.example.test",
  "ownerLogin": "owner@example.test",
  "port": 4317,
  "desktopPort": 9229,
  "dataDirectory": "data"
}
```

```powershell
npm.cmd start -- .\companion.config.json
```

This starts only the gateway; it does not launch or restart Codex, modify Tailscale, or send a message. Run it as the Windows user who owns the Codex session. In a fresh private test environment, use `tailscale serve status` first to make sure port 443 is not already in use. In a separate terminal, run `tailscale serve 4317` and use the reported HTTPS URL plus `/mobile` from your phone on Tailscale. Only proxy the gateway port, never the desktop debugger. Do not use Funnel. Ctrl+C stops the foreground processes. The page reports the desktop as unavailable until the local Codex renderer is connected.

The data directory is relative to the configuration file unless an absolute path is provided. Keep this directory private: it contains uploaded files and operation receipts. Do not run more than one gateway against the same data directory.

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

The renderer bridge uses a private desktop interface, not a supported Codex API. It requires an explicitly enabled local debugger and refuses non-loopback or ambiguous desktop targets. It is not exposed by the gateway. Do not proxy the debugging port or use a browser profile with it enabled as a substitute for the desktop app.

## Desktop adapter contract

`createGateway` in `gateway.cjs` takes an HTTPS origin, Tailscale owner login, data directory, and a desktop adapter. It binds only to IPv4 loopback. The adapter must use the same Codex desktop session for reads and writes, never launch a second engine to take over the conversation, and return unavailable when that desktop session cannot be reached.

- `health`, `rpc`, `workspaces`, `threadState`, and `setUnread` implement discovery and the allowlisted desktop actions.
- `send`, `lifecycle`, and `operationStatus` implement journaled writes. They take a caller-provided operation ID. An uncertain write must not be dispatched again.
- `approvals` returns currently pending requests with opaque string IDs, and `respond` must check that the same desktop request is still pending. `subscribe` returns an unsubscribe function and forwards desktop messages to the page's event stream.
