# 通过 MCP 直连中台

中台启动后，在现有监听地址提供 `/mcp`，不需要另起服务或开放另一个端口。例如中台在 `http://192.168.1.10:3350`，MCP URL 就是 `http://192.168.1.10:3350/mcp`。操作机只需支持 Streamable HTTP 和预配置 Bearer 请求头的 MCP 客户端，不需要源码、Node 或 SSH。支持 form Elicitation 的本人客户端还可以接收卡片并提交回答，不需要让模型调用等待工具。

## 客户端设置

在客户端中添加 HTTP MCP 服务，填写 URL，并通过客户端的凭据设置提供 `Authorization: Bearer <密钥>`。支持下面配置格式的客户端可参考：

```json
{
  "mcpServers": {
    "agent-autoloop": {
      "type": "http",
      "url": "http://192.168.1.10:3350/mcp",
      "headers": { "Authorization": "Bearer <本人或来源的访问密钥>" }
    }
  }
}
```

使用中台已有身份。需要单独撤销某个客户端时，可在中台用 `agent-autoloop key new owner <客户端名>` 签发独立的本人密钥，或用 `key new source <来源名>` 签发来源密钥。密钥是凭据，不写进项目文件、提示词或公开配置。当前入口使用预配置密钥，不提供 OAuth 登录。

| 身份 | 可用工具 |
| --- | --- |
| 本人 | `status`、`why`、`answer`、`resolve`、`stop`，以及 `workflow_list/show/start/pause/resume/cancel` |
| 来源 | `emit`、`tell`，只能使用该来源的身份 |
| worker、通道、轮次 token | 不能登录管理 MCP |

HTTP 每次请求都校验该密钥，撤销后下次请求立即拒绝。本人密钥不能调用来源工具；来源密钥不能查看和控制工作流。不要给 worker 启动的 Agent 配本人管理 MCP。

## Codex 项目级设置

Codex CLI 和桌面端 Codex 使用同一台 Codex 主机上的配置。将 MCP 放在操作者项目的 `.codex/config.toml`，该项目及其子目录中的 Codex 对话才能加载这份项目配置；项目需要已被信任。已有对话可能需要重新加载 MCP 或新开对话。项目配置不要求这个目录有 Agent Autoloop 源码。

Windows 示例，只包含连接信息。把 `me` 和 URL 换成实际值：

```toml
[mcp_servers.agent_autoloop]
url = "http://192.168.1.10:3350/mcp"
http_headers_helper = 'powershell.exe -NoProfile -NonInteractive -File "C:\Users\me\.codex\agent-autoloop-headers.ps1"'
```

`http_headers_helper` 指向项目外的凭据读取程序。它向 Codex 输出一个 HTTP 头 JSON 对象，不把密钥放进项目配置。可以在本人私有目录保存 `agent-autoloop-client.json`，内容格式为 `{"key":"已有的本人访问密钥"}`；不要提交该文件。对应 PowerShell helper 如下：

```powershell
$credential = Get-Content -Raw -LiteralPath "$env:USERPROFILE\.codex\agent-autoloop-client.json" | ConvertFrom-Json
@{ Authorization = "Bearer " + $credential.key } | ConvertTo-Json -Compress
```

不要把 helper 的输出抄进提示词或日志。桌面程序不一定继承终端临时设置的环境变量，使用这个 helper 可以让两种客户端读取同一份外置凭据。

还要让当前会话允许 MCP Elicitation 提示。若当前已经使用 granular 审批，只把 `mcp_elicitations` 改为 `true`，其余类别保留原值。若当前是 `never`，可以在项目配置顶层使用下面的 granular 策略，仅允许 Elicitation 提示，其他审批仍自动拒绝：

```toml
approval_policy = { granular = { sandbox_approval = false, rules = false, mcp_elicitations = true, request_permissions = false, skill_approval = false } }
```

这行应放在任何 `[mcp_servers...]` 表之前。当前是 `on-request` 时不需要为了接卡片改成上面的策略。会话参数可能覆盖项目默认值，应核对实际生效的审批设置；不要为了显示卡片扩大命令权限。

## 操作范围

工具已接入时，直接用 MCP 查询、启动已有工作流、回答或控制任务。工作流启动按规则名，其余单项查询与控制按工作项编号；回答选项从 0 开始，CLI 的选项序号从 1 开始。取消后查询实际状态，不能把请求成功当成执行已退出。

MCP 不安装程序、不改 `rules.json`，也不创建项目文件。这些操作继续在中台或 worker 上通过用户授权的远程命令完成，配置步骤见本 Skill 的其他手册。

## 主动卡片与回答

客户端在 `initialize` 中提供本人密钥，并声明 `capabilities.elicitation.form = {}` 时自动注册；`capabilities.elicitation = {}` 也表示支持 form。响应返回 `Mcp-Session-Id`。客户端随后发送 `notifications/initialized`，并以同一 Bearer 密钥和会话编号建立 GET SSE。连接期间，服务器可以直接发送 `elicitation/create`，不要求先有 `tools/call`。

卡片属于本人管理入口，范围与 `status` 相同；所有已注册的本人客户端都能收到本人可见卡片。它不是新的通知通道，不按规则的 `channels` 过滤，也不另建业务队列。不要把操作者项目配置放进 worker 要执行的业务项目中。

| 卡片或动作 | 行为 |
| --- | --- |
| 提问 | form 展示选项及补充文字；`choice` 是字符串下标，或 `free` 加非空 `text` |
| 普通通知 | form 用 `ack: true` 确认已处理，可附处理说明 `text` |
| 仅告知的 FYI、已回答或结案的卡片 | 用 `notifications/message` 更新，不再提问 |
| `accept` | 校验内容后调用原回答接口，叫醒原事项；同一张卡片只有第一次回答生效 |
| `decline`、`cancel` | 卡片仍开放；本次连接不重复问，断线重连后可再次显示 |

回答只接受原会话中服务器发出的请求编号，会话同时绑定认证密钥。重复相同回答不重复记录事实；其他客户端已回答时，未完成的对话框收到 `notifications/cancelled`。原 CLI 和 MCP `answer` 仍可回答，接受后也会取消旧对话框。不要让模型代替用户自动回答表单。

连接断开后保留会话 30 分钟；在此期间重连会从中台当前开放卡片恢复。到期、主动 DELETE 或中台重启后，旧会话编号不可用，客户端需重新初始化。卡片与已接受的回答仍在事实日志中，不随会话注销或重启丢失。断线或关闭对话框不等于取消业务任务。

## 传输行为

入口固定支持 MCP `2025-11-25`：先发送 `initialize`，后续请求带 `MCP-Protocol-Version: 2025-11-25`。每条消息用一次 POST；请求头包含 `Content-Type: application/json` 和 `Accept: application/json, text/event-stream`，这些由标准客户端处理。

没有 form Elicitation 能力的客户端、来源客户端仍使用无会话方式：普通请求返回 JSON，不分配 `Mcp-Session-Id`，没有会话的 GET、DELETE 返回 405。已注册的本人客户端用带会话编号的 GET 接收 SSE，用 POST 提交回答，用 DELETE 注销并关闭连接。通知和接受的客户端响应返回空的 HTTP 202；请求体最多 1 MiB。不实现旧 HTTP+SSE。stdio 继续提供原有工具，不增加主动卡片能力。

没有 `Origin` 的客户端可以直接连接；携带 `Origin` 时应与中台配置的 `hub.publicUrl` 的 origin 一致。未设置 `publicUrl` 时使用监听地址的 origin。当前不开放跨域浏览器访问。局域网 HTTP 会明文传输密钥和任务资料，只在用户信任的网络使用；跨不可信网络用 HTTPS 或加密隧道。

## 客户端验证

2026-11-09，在原生 Windows、Node 24.22.1 上，使用官方 `@modelcontextprotocol/sdk` 1.32.2 的 Streamable HTTP 客户端完成初始化、列工具、状态查询、工作流启动／暂停／恢复／取消／查询，以及来源发事件与去重。本人和来源分别连接真实 HTTP 入口；测试没有启动模型或执行项目代码。这份既有记录只覆盖常规工具，不代表 Elicitation 界面、所有 MCP 产品客户端或用户中台已经验收。
