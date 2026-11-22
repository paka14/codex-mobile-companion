# Codex Mobile Companion

An unofficial, self-hosted Windows companion for accessing your own Codex desktop sessions from a phone browser. The intended deployment uses a private Tailscale connection, with the gateway on your PC rather than on GitHub or a shared server.

[中文安装和实机验收](README.zh-CN.md) · [Security and vulnerability reporting](SECURITY.md)

## Development status

This is a **Windows developer preview**, not an installer. The repository includes a Windows launcher, mobile UI, loopback gateway and local Codex bridge. A clean Windows-to-phone run is still pending; no Codex desktop version is advertised as supported yet. Pinning is not available. Read markers apply only to the companion and reset when the gateway restarts.

The first runnable release is intended to cover session browsing, history, sending messages, and approvals. Notifications are not required for the first-run setup. Windows and Codex version support will be listed after a clean-machine test.

## Start on Windows

Install Node.js 24 or later, the official Codex desktop app for your Windows account, and Tailscale on the PC and phone. The launcher currently recognizes the `OpenAI.Codex` Windows app package, not a browser shortcut or another desktop distribution. Chrome is not required; use a current browser on the phone.

1. From Windows PowerShell, run `tailscale serve status`. On an unused test host, run `tailscale serve 4317` and keep its terminal open. If HTTPS port 443 is already configured, do not replace the existing service. See [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) for setup and HTTPS prerequisites.
2. Use [the example configuration](companion.config.example.json) for `companion.config.json` beside the launcher. In `origin`, set the exact HTTPS origin reported by Serve, without a trailing slash. Set `ownerLogin` to the account the phone uses in Tailscale. Only the configured login is allowed. Keep the real configuration out of Git.
3. Run the preflight and then start the companion:

```powershell
.\Start-Companion.ps1 -Check
.\Start-Companion.ps1
```

4. On the phone, connect Tailscale and open the Serve URL with `/mobile` appended. Check gateway readiness at `/mobile-api/ready` from the same phone when troubleshooting.

`-Check` never starts or stops anything. `launch` means that no desktop is running and the launcher can try to start it; `ready` means that the listener matches the expected desktop process, not that its app interfaces have passed the web readiness check. For `existing-incompatible`, finish or save your work before quitting Codex normally, then rerun the launcher. It never closes an existing Codex. If you change the gateway port, use that port in the Serve command too.

Use Ctrl+C in the gateway and Serve terminals to stop them. The desktop remains open; quit it normally when done to turn off the desktop debugger. The launcher does not set up Tailscale or change Windows execution policy. A custom file can be provided with `-ConfigPath`. To start only the gateway for development, run `npm.cmd start -- .\companion.config.json`.

The data directory is relative to the configuration file unless an absolute path is provided. Keep this directory private: it contains uploaded files and operation receipts. Do not run more than one gateway against the same data directory.

## Run the module checks

Use Node.js 24 or later. The checks require no dependencies, credentials, network calls, or running Codex instance.

```sh
npm test
```

The GitHub Actions workflow runs the same checks on Windows and Linux. Passing module checks does not establish that a Codex desktop version is supported.

On Windows, run `powershell.exe -NoProfile -File .\test\windows-launcher.ps1` to check launch and refusal paths without launching Codex.

The optional browser fixture uses Playwright and Chromium. With Playwright available on Node's module path and its browser installed, run `node test/browser-mobile.cjs`. Set `PLAYWRIGHT_CHANNEL=msedge` to use an installed Microsoft Edge. The fixture verifies the mobile page at 320, 390, and 1280 px against synthetic responses; it does not connect to Codex.

## Security boundary

The preview access module assumes a trusted, loopback-only proxy. It is not a standalone authentication server. Do not expose a gateway or an Electron debugging port to the public internet. Do not include credentials, private links, real sessions, or runtime logs in issue reports.

No third-party application binaries, extracted application assets, or user runtime data are included. Distribution terms for the source must be settled before public release.

The renderer bridge uses a private desktop interface, not a supported Codex API. It requires an explicitly enabled local debugger and refuses non-loopback or ambiguous desktop targets. It is not exposed by the gateway. Local programs can access a local debugger; use this only on a machine you trust. Only proxy the gateway port in Serve. Never proxy the debugging port, use Tailscale Funnel, or substitute a Chrome debug profile for the desktop app.

## Desktop adapter contract

`createGateway` in `gateway.cjs` takes an HTTPS origin, Tailscale owner login, data directory, and a desktop adapter. It binds only to IPv4 loopback. The adapter must use the same Codex desktop session for reads and writes, never launch a second engine to take over the conversation, and return unavailable when that desktop session cannot be reached.

- `health`, `rpc`, `workspaces`, `threadState`, and `setUnread` implement discovery and the allowlisted desktop actions.
- `send`, `lifecycle`, and `operationStatus` implement journaled writes. They take a caller-provided operation ID. An uncertain write must not be dispatched again.
- `approvals` returns currently pending requests with opaque string IDs, and `respond` must check that the same desktop request is still pending. `subscribe` returns an unsubscribe function and forwards desktop messages to the page's event stream.
