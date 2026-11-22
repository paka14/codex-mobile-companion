# Codex 手机伴侣

这是一个非官方、自托管的 Windows 工具。电脑继续运行自己的 Codex 桌面客户端；手机通过 Tailscale 私有网络，用浏览器打开伴侣页面。GitHub 只托管代码，不中转聊天、文件或审批。不需要 Chrome，也不需要在手机上运行 Codex。

目前是开发预览版，不是安装包。模拟环境已覆盖会话列表、历史、发消息和审批；干净 Windows 与真实手机联通还待验证，暂不承诺支持任何 Codex 桌面版本。暂不提供置顶；已读标记只在伴侣服务内保留，服务重启后清除。

## 手机端功能

- **连接诊断**：查看、下载或清除浏览器本地记录；「拉取电脑状态」补充网关就绪状态和近期变化。同一浏览器首次成功在线打开后，后续离线时可记录浏览器检测到的导航失败并导出报告。不上传报告，不记录聊天或凭据，不能读取系统日志或仅凭导航失败判断 DNS、路由故障。
- **会话目标**：已有目标时可快捷编辑、在相应状态下暂停或继续，以及确认后清除。编辑会核对目标内容和状态是否仍与打开时一致；发生冲突时重新打开目标并核对桌面状态。
- **状态角标**：区分运行中、未读、会话出错、待回答和待审批；同一会话同时有两类待处理请求时分别计数。
- **自动任务小钟（默认关闭）**：在私有配置中将 `automationDirectory` 设为自己控制的本机 Codex 自动任务目录的绝对路径，不是上级 Codex 主目录。未配置时不读取；只显示列表会话关联的启用和暂停计数，不返回任务名称、提示词或计划，也不修改任务。不支持的文件格式不显示角标。

## 在 Windows 试用

先安装 Node.js 24 或更高版本、适用于当前 Windows 用户的官方 Codex 桌面应用，以及两端的 Tailscale。启动器当前只识别 Windows 的 `OpenAI.Codex` 应用包。

1. 在 PowerShell 用 `tailscale serve status` 查看现有配置。只在测试机且确认 HTTPS 443 没被现有服务占用时，运行 `tailscale serve 4317`，保留该终端。不要启用 Funnel。HTTPS 配置见 [Tailscale Serve 文档](https://tailscale.com/docs/features/tailscale-serve)。
2. 根据 [配置示例](companion.config.example.json) 创建同目录的 `companion.config.json`。`origin` 填 Serve 给出的 HTTPS 源，不带结尾斜杠；`ownerLogin` 填手机在 Tailscale 上使用的账号。真实配置和数据目录不应上传。
3. 在另一个 PowerShell 中先预检，再启动：

```powershell
.\Start-Companion.ps1 -Check
.\Start-Companion.ps1
```

4. 手机连上 Tailscale，打开 Serve 地址加 `/mobile`。排错时在同一手机打开 `/mobile-api/ready`；`ready: true` 表示网关检测到了必要的桌面接口，不代表已验收真实操作。

预检不启停进程。遇到 `existing-incompatible`，先保存桌面工作，再正常退出 Codex 后重试。遇到 `unsafe-listener`，不要代理该端口或接管未知进程；检查端口占用或在独立测试机重试。结束时分别在网关和 Serve 终端按 Ctrl+C，正常退出 Codex 即可关闭本次桌面调试端口。更多说明见 [英文 README](README.md)。

## 实机验收

使用独立测试机和一次性 Codex 会话，不用真实项目、密钥或工作文件。记录 Windows、Codex、Node、手机浏览器版本及仓库提交号：

1. 在电脑测试会话里留一条无敏感内容的消息。手机应在会话列表里找到同一标题，打开后看到这条历史。
2. 从手机发一条可识别的短消息。电脑应在同一会话收到且只收到一次；手机随后应能看到这条消息及回复。若页面提示回执不明确，先查桌面实际状态，不要直接重发。
3. 仅在一次性测试目录和保留原审批策略的前提下，使用会自然产生审批的无害测试操作。手机应能看到待审请求，从手机拒绝后，桌面应显示本次请求已拒绝，手机待审项消失。无法触发审批时标记「未测」，不要改成跳过审批。
4. 确认可访问入口仅是私有 Serve URL，且未代理调试端口。完成后按上节退出。

自动检查可运行 `npm.cmd test`、`powershell.exe -NoProfile -File .\test\windows-launcher.ps1`。已安装 Playwright 及其浏览器时，可运行 `node test/browser-mobile.cjs` 和 `node test/browser-diagnostics.cjs`；也可设置 `PLAYWRIGHT_CHANNEL=msedge` 使用已安装的 Edge。这些检查使用合成数据，不代替实机验收。

复现问题时只报告脱敏结果。安全问题按 [安全说明](SECURITY.md) 私下报告。

本项目源码采用 [MIT 许可证](LICENSE)，不包含或授权另行安装的 Codex 和 Tailscale。
