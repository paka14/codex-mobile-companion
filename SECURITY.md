# Security

This repository is a developer preview. There are no supported versions or security update guarantees yet.

## Deployment boundaries

- Run the launcher and gateway only on your own trusted Windows host. The companion can display private conversations and submit actions that Codex executes under your account. Do not share the configured Tailscale login.
- Use private Tailscale Serve with the gateway bound to loopback. Do not use Funnel, a public reverse proxy, port forwarding, or any setup that lets clients supply trusted identity headers directly.
- Keep the desktop debugging endpoint on loopback and never expose it through Serve. A different local program may be able to use that endpoint. Quit Codex normally when done to close the debug listener.
- Keep the real configuration, uploaded files and operation receipts private. Do not weaken Codex's approval policy to make the companion work.

## Reporting a security issue

Contact the repository maintainer privately. Use the repository's private vulnerability reporting form if available; otherwise request a private channel without posting the details.

Include the affected commit, component, impact and minimal steps using synthetic data. Do not publish tokens, device or account names, private URLs, project paths, conversation IDs, attachments or real logs.
