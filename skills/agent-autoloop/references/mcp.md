# 通过 MCP 直连中台

中台启动后，在现有监听地址提供 `/mcp`，不需要另起服务或开放另一个端口。例如中台在 `http://192.168.1.10:3350`，MCP URL 就是 `http://192.168.1.10:3350/mcp`。操作机只需支持 Streamable HTTP 和预配置 Bearer 请求头的 MCP 客户端，不需要源码、Node 或 SSH。

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

## 操作范围

工具已接入时，直接用 MCP 查询、启动已有工作流、回答或控制任务。工作流启动按规则名，其余单项查询与控制按工作项编号；回答选项从 0 开始，CLI 的选项序号从 1 开始。取消后查询实际状态，不能把请求成功当成执行已退出。

MCP 不安装程序、不改 `rules.json`，也不创建项目文件。这些操作继续在中台或 worker 上通过用户授权的远程命令完成，配置步骤见本 Skill 的其他手册。

## 传输行为

入口固定支持 MCP `2025-11-25`：先发送 `initialize`，后续请求带 `MCP-Protocol-Version: 2025-11-25`。每条消息用一次 POST；请求头包含 `Content-Type: application/json` 和 `Accept: application/json, text/event-stream`，这些由标准客户端处理。

服务器返回 JSON；通知和客户端响应返回空的 HTTP 202。不分配 `Mcp-Session-Id`，GET 和 DELETE 返回 405，不提供旧 HTTP+SSE 入口或独立 SSE 流。请求体最多 1 MiB。HTTP 连接断开不等于取消任务，用工作流取消工具显式停止。

没有 `Origin` 的客户端可以直接连接；携带 `Origin` 时应与中台配置的 `hub.publicUrl` 的 origin 一致。未设置 `publicUrl` 时使用监听地址的 origin。当前不开放跨域浏览器访问。局域网 HTTP 会明文传输密钥和任务资料，只在用户信任的网络使用；跨不可信网络用 HTTPS 或加密隧道。

## 客户端验证

2026-11-09，在原生 Windows、Node 24.22.1 上，使用官方 `@modelcontextprotocol/sdk` 1.32.2 的 Streamable HTTP 客户端完成初始化、列工具、状态查询、工作流启动／暂停／恢复／取消／查询，以及来源发事件与去重。本人和来源分别连接真实 HTTP 入口；测试没有启动模型或执行项目代码。这个记录不代表所有 MCP 产品客户端均已验收，也不代表已部署用户的中台。
