# Codex 手机伴侣

这是一个非官方、自托管的 Windows 工具。电脑继续运行自己的 Codex 桌面客户端；手机通过 Tailscale 私有网络，用浏览器打开伴侣页面。GitHub 只托管代码，不中转聊天、文件或审批。不需要 Chrome，也不需要在手机上运行 Codex。

目前是开发预览版，不是安装包。模拟环境已覆盖会话列表、历史、发消息和审批；干净 Windows 与真实手机联通还待验证，暂不承诺支持任何 Codex 桌面版本。暂不提供置顶；已读标记只在伴侣服务内保留，服务重启后清除。

## 手机端功能

- **连接诊断**：查看、下载或清除浏览器本地记录；「拉取电脑状态」补充网关就绪状态和近期变化。同一浏览器首次成功在线打开后，后续离线时可记录浏览器检测到的导航失败并导出报告。不上传报告，不记录聊天或凭据，不能读取系统日志或仅凭导航失败判断 DNS、路由故障。
- **会话目标**：已有目标时可快捷编辑、在相应状态下暂停或继续，以及确认后清除。编辑会核对目标内容和状态是否仍与打开时一致；发生冲突时重新打开目标并核对桌面状态。
- **状态角标**：区分运行中、未读、会话出错、待回答和待审批；同一会话同时有两类待处理请求时分别计数。
- **自动任务小钟（默认关闭）**：在私有配置中将 `automationDirectory` 设为自己控制的本机 Codex 自动任务目录的绝对路径，不是上级 Codex 主目录。未配置时不读取；只显示列表会话关联的启用和暂停计数，不返回任务名称、提示词或计划，也不修改任务。不支持的文件格式不显示角标。

## 在 Windows 试用

使用 Windows x64 便携 ZIP 时，先与可信来源的校验值比对 SHA-256，再解压到新目录。包中已带 Node，不用安装 npm 依赖；源码模式需要 Node.js 24 或更高版本。先在电脑安装并登录官方 Codex 桌面应用和 Tailscale，手机也要安装并登录 Tailscale。启动器只识别 `OpenAI.Codex` Windows 应用包。

1. 双击 `Start Companion.cmd`，输入手机 Tailscale 上显示的登录名，确认检测到的 HTTPS 主机名。新配置保存在 `%LOCALAPPDATA%\CodexMobileCompanion`，允许继续已有会话、读取历史、发送文字及处理已有审批；不允许新建、上传文件或改模型、权限、目标。已有配置不改，保留原功能。
2. 仅在独立测试环境中，若启动器提示未配置专用映射，在另一 PowerShell 窗口按提示运行 `tailscale serve --https=443 http://127.0.0.1:4317`，保留窗口，再重开启动器。不要加 `--bg`、启用 Funnel、覆盖其他服务或代理调试口。HTTPS 设置见 [Tailscale Serve 文档](https://tailscale.com/docs/features/tailscale-serve)。
3. 按需确认启动 Codex。看到 `[BRIDGE:READY]` 和 `/mobile` 地址后，在已连 Tailscale 的手机现有浏览器打开；不需要 Chrome 或伴侣 App。

预检：`powershell.exe -NoProfile -File .\Start-Companion.ps1 -Check` 不创建配置或启停服务。按首条 `STOPPED` 处理：`RUNTIME` 查解压或 Node，`PROFILE` 查主机名和账号，`TAILSCALE` 查登录，`SERVE` 查专用映射，`DESKTOP` 查桌面监听，`GATEWAY` 查端口和桥接。已有 Codex 不兼容时先保存工作再正常退出。手机遇到证书错误不要绕过；403 查手机账号，503 查电脑网关及 Codex。就绪不代表实机验收通过。

停止时分别在网关和专用 Serve 窗口按 Ctrl+C，再正常退出 Codex 以关闭调试监听。升级解压到新目录，回滚先停网关，再运行上一个已验证目录。先备份私有配置和回执，不要同时开两个网关或重发状态不明的消息。便携包附 Node 许可证和组件清单，不含 Codex、Tailscale 或用户数据。构建说明见 [英文 README](README.md)。

## 实机验收

使用独立测试机和一次性 Codex 会话，不用真实项目、密钥或工作文件。记录 Windows、Codex、Node、手机浏览器版本及仓库提交号：

1. 在电脑测试会话里留一条无敏感内容的消息。手机应在会话列表里找到同一标题，打开后看到这条历史。
2. 从手机发一条可识别的短消息。电脑应在同一会话收到且只收到一次；手机随后应能看到这条消息及回复。若页面提示回执不明确，先查桌面实际状态，不要直接重发。
3. 仅在一次性测试目录和保留原审批策略的前提下，使用会自然产生审批的无害测试操作。手机应能看到待审请求，从手机拒绝后，桌面应显示本次请求已拒绝，手机待审项消失。无法触发审批时标记「未测」，不要改成跳过审批。
4. 用非所有者 tailnet 身份验证拒绝，再断开手机 Tailscale 验证入口不可达。确认只代理网关，桌面调试端口仅监听电脑回环。停止网关时 Codex 应保留；停止本次前台 Serve 后手机应无法访问。

自动检查可运行 `npm.cmd test`、`powershell.exe -NoProfile -File .\test\windows-launcher.ps1`。已安装 Playwright 及其浏览器时，可运行 `node test/browser-mobile.cjs` 和 `node test/browser-diagnostics.cjs`；也可设置 `PLAYWRIGHT_CHANNEL=msedge` 使用已安装的 Edge。这些检查使用合成数据，不代替实机验收。

复现问题时只报告脱敏结果。安全问题按 [安全说明](SECURITY.md) 私下报告。

本项目源码采用 [MIT 许可证](LICENSE)，不包含或授权另行安装的 Codex 和 Tailscale。
