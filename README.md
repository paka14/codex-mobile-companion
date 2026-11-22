# Codex Mobile Companion

An unofficial, self-hosted Windows companion for accessing your own Codex desktop sessions from a phone browser. The intended deployment uses a private Tailscale connection, with the gateway on your PC rather than on GitHub or a shared server.

## Development status

This is a **source preview**, not an installer or a runnable remote-control service. It contains isolated modules for private access checks, conversation history snapshots, and operation receipts. The production gateway, Windows launcher, and mobile UI are not included in this snapshot. Installing Node.js or cloning this repository will not start a gateway or connect to Codex.

The first runnable release is intended to cover session browsing, history, sending messages, and approvals. Notifications are not required for the first-run setup. Windows and Codex version support will be listed after a clean-machine test.

## Run the module checks

Use Node.js 24 or later. The checks require no dependencies, credentials, network calls, or running Codex instance.

```sh
npm test
```

The GitHub Actions workflow runs the same checks on Windows and Linux. Passing module checks does not establish that a Codex desktop version is supported.

## Security boundary

The preview access module assumes a trusted, loopback-only proxy. It is not a standalone authentication server. Do not expose a gateway or an Electron debugging port to the public internet. Do not include credentials, private links, real sessions, or runtime logs in issue reports.

No third-party application binaries, extracted application assets, or user runtime data are included. Distribution terms for the source must be settled before public release.
