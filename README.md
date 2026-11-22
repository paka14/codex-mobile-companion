# Codex Mobile Companion

An unofficial, self-hosted Windows companion for accessing your own Codex desktop sessions from a phone browser. The intended deployment uses a private Tailscale connection, with the gateway on your PC rather than on GitHub or a shared server.

[中文安装和实机验收](README.zh-CN.md) · [Security and vulnerability reporting](SECURITY.md)

## Development status

This is a **Windows developer preview**, not an installer. The repository includes a Windows launcher, mobile UI, loopback gateway and local Codex bridge. A clean Windows-to-phone run is still pending; no Codex desktop version is advertised as supported yet. Pinning is not available. Read markers apply only to the companion and reset when the gateway restarts.

The first runnable release is intended to cover session browsing, history, sending messages, and approvals. Notifications are not required for the first-run setup. Windows and Codex version support will be listed after a clean-machine test.

## Connection diagnostics

Open **连接诊断** on the mobile home screen to inspect, download or clear local errors. **拉取电脑状态** adds a read-only snapshot and recent readiness changes from the running gateway. Logs contain timestamps, error categories and HTTP status codes, never chat content or credentials. The companion does not upload reports.

After one successful online visit in the same browser profile, the offline screen can capture browser-observed navigation failures and export them without contacting the gateway. It cannot inspect Tailscale or Android system logs, or diagnose failures before the offline screen is installed. A browser navigation error alone does not distinguish DNS from routing failures.

## Goals and conversation status

An existing desktop goal gets shortcuts to edit its text, pause or resume it when available, and clear it with confirmation. Editing checks that the objective and status still match the version shown; on a conflict, reopen the goal and check the desktop state before editing again. Conversation badges distinguish running, unread, error, awaiting an answer, and awaiting approval. In a conversation, mixed pending requests show separate counts.

To show a clock for conversations with linked heartbeat automations, set `automationDirectory` in your private configuration to the absolute path of your local Codex automations directory, not the parent Codex home directory. Leave it out to disable all automation reads. Use only a directory that you control. The gateway returns active and paused counts for listed conversations, not automation names, prompts, or schedules. Unsupported file formats produce no badge. The companion does not change automations.

## Start on Windows

For a Windows x64 portable ZIP, compare its SHA-256 against a trusted digest before extracting to a fresh directory. Node is bundled; no npm install is needed. A source checkout requires Node.js 24 or later. Install and sign in to the official Codex desktop app and Tailscale first (Tailscale is also needed on the phone). The launcher recognizes the `OpenAI.Codex` Windows app package.

1. Double-click `Start Companion.cmd`. Enter the exact Tailscale login from your phone and confirm the detected HTTPS name. A new profile under `%LOCALAPPDATA%\CodexMobileCompanion` allows existing conversation history, text replies and pending approvals. It does not allow creation, uploads, or edits to goals, models or permissions. Existing profiles are not changed and retain their previous capabilities.
2. When prompted on a dedicated test host with no conflict, run `tailscale serve --https=443 http://127.0.0.1:4317` in another PowerShell window. Leave that window open and retry the launcher. Do not use `--bg`, Funnel, another service's mapping, or the desktop debug port. See [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) for HTTPS prerequisites.
3. Approve desktop launch when asked. After `[BRIDGE:READY]` appears, connect Tailscale on the phone and open the printed `/mobile` URL in your existing browser.

Run `powershell.exe -NoProfile -File .\Start-Companion.ps1 -Check` for a read-only preflight. Follow the first stopped layer: runtime, profile, Tailscale, Serve, desktop, or gateway. If the existing desktop is incompatible, save your work and quit Codex normally before retrying. On the phone, do not bypass certificate warnings; a 403 calls for checking the Tailscale login and a 503 for checking gateway and desktop readiness. Local readiness is not real-device acceptance.

Use Ctrl+C in the Companion window, then separately stop the dedicated Serve window. Quit Codex normally to close its debugger. Companion does not change Tailscale or Windows execution policy. Update by extracting to a fresh folder, and roll back by stopping Companion and running the previous verified folder. Back up the private profile and receipts. Do not run two gateways on the same data or blindly resend an uncertain write. Use `-ConfigPath` for an explicit profile and `-Setup` to stop after profile validation.

Build with `powershell.exe -NoProfile -File .\Build-WindowsPortable.ps1 -NodeArchive <archive> -OutputDirectory <directory> -Version <candidate>`. Download the exact official ZIP in [the Node lock](packaging/node-win-x64.json). The builder verifies the archive hash and the Node executable's Authenticode signature and includes the runtime license and component SBOM. The outer preview ZIP is unsigned; its checksum is not publisher authentication. Release signing and independent Windows-to-phone acceptance remain separate gates.

## Run the module checks

Use Node.js 24 or later. The checks require no dependencies, credentials, network calls, or running Codex instance.

```sh
npm test
```

The GitHub Actions workflow runs the same checks on Windows and Linux. Passing module checks does not establish that a Codex desktop version is supported.

On Windows, run `powershell.exe -NoProfile -File .\test\windows-launcher.ps1` to check launch and refusal paths without launching Codex.

The optional browser fixtures use Playwright and Chromium. With Playwright available on Node's module path and its browser installed, run `node test/browser-mobile.cjs` and `node test/browser-diagnostics.cjs`. Set `PLAYWRIGHT_CHANNEL=msedge` to use an installed Microsoft Edge. These fixtures use synthetic sessions and connection failures and do not connect to Codex.

## Security boundary

The preview access module assumes a trusted, loopback-only proxy. It is not a standalone authentication server. Do not expose a gateway or an Electron debugging port to the public internet. Do not include credentials, private links, real sessions, or runtime logs in issue reports.

The companion source is licensed under the [MIT License](LICENSE). The separately installed Codex and Tailscale applications are not distributed or licensed by this project. No third-party application binaries, extracted application assets, or user runtime data are included.

The renderer bridge uses a private desktop interface, not a supported Codex API. It requires an explicitly enabled local debugger and refuses non-loopback or ambiguous desktop targets. It is not exposed by the gateway. Local programs can access a local debugger; use this only on a machine you trust. Only proxy the gateway port in Serve. Never proxy the debugging port, use Tailscale Funnel, or substitute a Chrome debug profile for the desktop app.

## Desktop adapter contract

`createGateway` in `gateway.cjs` takes an HTTPS origin, Tailscale owner login, data directory, and a desktop adapter. It binds only to IPv4 loopback. The adapter must use the same Codex desktop session for reads and writes, never launch a second engine to take over the conversation, and return unavailable when that desktop session cannot be reached.

- `health`, `rpc`, `workspaces`, `threadState`, and `setUnread` implement discovery and the allowlisted desktop actions.
- `send`, `lifecycle`, and `operationStatus` implement journaled writes. They take a caller-provided operation ID. An uncertain write must not be dispatched again.
- `approvals` returns currently pending requests with opaque string IDs, and `respond` must check that the same desktop request is still pending. `subscribe` returns an unsubscribe function and forwards desktop messages to the page's event stream.
