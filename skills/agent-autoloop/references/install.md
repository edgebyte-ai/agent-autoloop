# 从已有程序包全新安装

本手册随 Skill 一起分发。操作机不需要源码或本机中台程序；下面的安装命令在目标中台或 worker 上执行。分机安装时使用用户授权的 SSH 或远程执行入口，不把命令默认执行在操作机。装好后，查询、回答和工作流控制可用 [MCP 直连](mcp.md)，无需为这些操作登录服务器。

当前程序由 Node 24 直接运行 TypeScript，没有单独的编译步骤。完整程序包可以直接安装，目标机器不需要拉源码、运行 `npm install` 或编译。Node、Git 和所用 Agent CLI 仍由目标机器提供；纯中台不需要 Agent CLI。

准备程序包的机器从已经准备好的安装中只打包 `app` 目录，保留里面的 `.git` 以显示提交和版本。不要打包上层数据目录里的配置、密钥、数据库、运行记录或 Agent 登录资料；程序目录和 Git 配置中也不能夹带凭据。打包前停止改动这个程序目录。

```bash
tar -czf /tmp/agent-autoloop-app.tar.gz -C "$HOME/.agent-autoloop" app
```

通过共享目录、文件传输或已有下载地址把包交给目标机器。下面假定包已经在目标机器的 `/tmp/agent-autoloop-app.tar.gz`，中台局域网 IP 是 `192.168.1.10`。按实际情况替换。以下步骤用于全新安装，目标数据目录中不应已有 `app` 或 `config.json`；已有安装不要直接覆盖。

1. 在 Linux 中台机器解压程序，初始化配置。

   ```bash
   mkdir -p -m 700 "$HOME/.agent-autoloop"
   tar -xzf /tmp/agent-autoloop-app.tar.gz -C "$HOME/.agent-autoloop"
   chmod +x "$HOME/.agent-autoloop/app/bin/agent-autoloop.ts"
   mkdir -p "$HOME/.local/bin"
   ln -s "$HOME/.agent-autoloop/app/bin/agent-autoloop.ts" "$HOME/.local/bin/agent-autoloop"
   export PATH="$HOME/.local/bin:$PATH"
   agent-autoloop init --no-service --command true
   ```

   后续终端也需要 `~/.local/bin` 在 PATH 中；也可直接使用程序完整路径。`--command true` 只让纯中台完成初始化，不用于执行开发任务。

2. 编辑中台 `~/.agent-autoloop/config.json`。保留生成的 `owner` 和 `source`，删除 `worker`，把 `channels` 改成 `{}`，设置：

   ```json
   {
     "url": "http://192.168.1.10:3350",
     "hub": {
       "listen": "192.168.1.10:3350",
       "publicUrl": "http://192.168.1.10:3350"
     }
   }
   ```

   这是要修改的字段，不是替换整份配置。`publicUrl` 是卡片链接的访问地址，不要求公网或域名。不需要卡片链接时可省略；监听 `0.0.0.0` 时应另填真实可访问的链接地址。

3. 将全新中台的 `rules.json` 改为下面的空配置，移除占位 Agent 和桌面通知。

   ```json
   {
     "sources": { "local": { "name": "手动事件" } },
     "agents": {},
     "channels": {},
     "rules": []
   }
   ```

4. 检查并启动中台，再签发 worker 密钥。

   ```bash
   agent-autoloop check
   agent-autoloop service install
   agent-autoloop key new worker linux-dev
   ```

5. 在 Linux worker 机器解压同一份包，并运行上面的 `chmod`、命令链接和 PATH 设置。不要运行 `init`，改为加入中台：

   ```bash
   agent-autoloop join http://192.168.1.10:3350 \
     --worker linux-dev --key '<上一步的 worker 密钥>' --no-service
   agent-autoloop service install
   ```

   worker 的配置只需要 `url` 和 `worker`。可在启动前给 `worker` 增加 `capacity`，默认 2。Agent CLI、项目依赖和 Git 认证留在这台机器。worker 不需要开放入站端口。

6. 按 [项目操作](projects.md) 在中台登记真实 Agent 并配置首个项目，再运行 `agent-autoloop status` 查看连接。只有配置好真实 Agent 和规则后，才执行消耗模型额度的任务；纯中台的空规则不能直接运行 `try`。

Linux 内置服务使用 `systemctl --user`。需要退出登录后继续运行时，在中台和 Linux worker 各执行 `sudo loginctl enable-linger "$USER"`。没有 systemd 的机器运行 `agent-autoloop up`，交给已有进程管理器托管。

中台启动后，Streamable HTTP MCP 与业务接口共用端口，地址为 `http://192.168.1.10:3350/mcp`。客户端提供本人或来源的 Bearer 密钥即可连接，无须另起 MCP 进程。支持 form Elicitation 的本人客户端还会自动注册收卡片，保持 GET SSE 后可在客户端表单里回答；来源客户端不注册。Codex 项目级连接、外置凭据 helper 和 Elicitation 审批设置见 [MCP 直连](mcp.md)。

局域网 HTTP 可以连接，密钥和任务资料会明文传输，只用于用户信任的网络。跨不可信网络用 HTTPS 或加密隧道。公网入口才需要另配反向代理；没有公网地址不阻止中台和 worker 在局域网工作。

程序包中的 Skill 位于 `app/skills/agent-autoloop/SKILL.md`。默认安装时，`init` 或 `service install` 会给已有的 `~/.codex`、`~/.claude` 目录建立 Skill 链接。自定义 `AGENT_AUTOLOOP_HOME` 时不自动链接，可把程序内这个 Skill 的完整路径交给操作者 Agent；不要给执行任务的 Agent 配本人管理 MCP。

这种安装不配置下载或自动升级入口。`agent-autoloop update` 仍按程序目录的 Git 来源更新，不能把它当作“取得新程序包”；采用程序包分发时，后续升级也从同一分发位置取包，停止中台和 worker 服务后替换程序，保留上层数据目录。

