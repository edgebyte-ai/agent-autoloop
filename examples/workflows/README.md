# 轻量工作流示例

这些示例使用同一个执行器。`rules.json` 中的 `workflow` 字段启用工作流。没有这个字段的规则仍按普通任务执行。

| 模板 | 执行内容 | 默认上限 |
| --- | --- | --- |
| `single` | 一位执行者写文档，允许续接和提问，完成后导出 | 5 次 Agent 执行 |
| `drdr` | 执行者写文档，两位独立 Reviewer 审查，汇总后修复，再次审查，最后导出 | 3 次开发、各 3 次审查 |
| `recursive_prdr` | Planner 划分子项，Plan Reviewer 审查，子项完成后父项整合 | 深度 3、累计 12 个子项、60 次 Agent 执行 |
| `data` | 读取数据、清理空白、计算、核对、输出 | 60 秒累计活动时间，不调用模型 |
| `coding` | 从已有本地仓库建立工作树，开发、双人审查、本机测试、提交、推分支和创建 PR | 4 次开发、各 4 次审查 |

每个工作项有独立目录。Developer、各位 Reviewer、Planner 使用各自的 thread。修复和复审继续原角色的 thread。两位 Reviewer 都结束后，执行者才会收到汇总意见。

## 在独立测试中台运行

以下 PowerShell 命令在本仓库根目录执行。需要 Node 24、Git 和已登录的原生 Codex CLI。命令使用新的临时数据目录和空闲端口，不连接已有中台。

1. 初始化测试中台。

   ```powershell
   $repo = (Get-Location).Path
   $env:AGENT_AUTOLOOP_HOME = Join-Path $env:TEMP ("autoloop-workflow-demo-" + [guid]::NewGuid())
   $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
   $listener.Start()
   $port = $listener.LocalEndpoint.Port
   $listener.Stop()
   node "$repo\bin\agent-autoloop.ts" init --agent codex --port $port --no-service
   ```

2. 生成本机配置，并检查配置。

   ```powershell
   node "$repo\examples\workflows\configure.ts" $env:AGENT_AUTOLOOP_HOME
   node "$repo\bin\agent-autoloop.ts" check "$env:AGENT_AUTOLOOP_HOME\rules.workflows.json"
   Copy-Item "$env:AGENT_AUTOLOOP_HOME\rules.workflows.json" "$env:AGENT_AUTOLOOP_HOME\rules.json"
   ```

   `configure.ts` 替换示例脚本路径和 worker 名字，并把仓库与发布配置写进命令参数。工作目录位于这个测试目录的 `workflows/<工作项编号>`。原始模板中的 `{examples}`、`{repository}` 和 `{publisher}` 是生成器占位符，应先运行这个生成命令。

3. 关闭测试中台的通知通道。

   ```powershell
   $configPath = Join-Path $env:AGENT_AUTOLOOP_HOME "config.json"
   $config = Get-Content -Raw $configPath | ConvertFrom-Json
   $config.channels = @{}
   $config.worker | Add-Member -Force NoteProperty capacity 2
   [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
   Write-Output $env:AGENT_AUTOLOOP_HOME
   ```

   保存输出的测试目录路径。后面的终端使用同一个路径。

4. 在这个终端启动中台。

   ```powershell
   node "$repo\bin\agent-autoloop.ts" up
   ```

5. 在第二个终端设置测试目录，并启动数据工作流。

   ```powershell
   $env:AGENT_AUTOLOOP_HOME = "第一步生成的完整测试目录路径"
   node .\bin\agent-autoloop.ts workflow start 数据计算
   node .\bin\agent-autoloop.ts workflow list
   ```

   找到工作项编号后，运行 `workflow show <编号> --json`。完成时，`workflows/<编号>/result.json` 应为：

   ```json
   { "count": 3, "total": 12, "average": 4 }
   ```

   这个流程保留重复出现的记录，不需要 Git 仓库，也不启动 Agent。

6. 启动一个模型工作流。

   ```powershell
   node .\bin\agent-autoloop.ts workflow start 单人文档
   node .\bin\agent-autoloop.ts workflow start 双人审查文档
   node .\bin\agent-autoloop.ts workflow start 递归文档
   ```

   按需运行其中一条即可。文档产物位于对应目录的 `output/document.md`。

macOS 和 Linux 使用相同的 Node 入口、配置文件和 CLI 命令。把环境变量设置改成当前 shell 的写法，使用该平台的绝对路径即可。

## 查询、暂停、恢复和取消

```powershell
node .\bin\agent-autoloop.ts workflow list
node .\bin\agent-autoloop.ts workflow show 1 --json
node .\bin\agent-autoloop.ts workflow pause 1 --reason "检查当前产物"
node .\bin\agent-autoloop.ts workflow resume 1
node .\bin\agent-autoloop.ts workflow cancel 1 --reason "目标已撤回"
node .\bin\agent-autoloop.ts status --json
```

将 `1` 换成真实工作项编号。控制根工作项时，控制请求覆盖其子项。指定子项时，只控制该子项及其后代。

暂停阻止新步骤、Turn 和子项准入。已准入的步骤会收尾，所以暂停请求不等于已经没有活动。执行器确认该工作项的全部执行已退出后，才把取消记为完成。`show` 保留实际活动、等待原因、执行次数、角色会话和结果；心跳不会算成实际进展。

Agent 提问后结束本次执行。用 `status` 查卡片，再用 `answer <卡片编号> <选项序号>` 回答。等待期间没有新的模型执行，执行名额已释放；共享 app-server 可以保持运行。超过配置的空闲时间后，thread 可以卸载，回答到达时再 resume。

## 配置开发与代码交付

**警告：** `本地代码交付` 最后会向远端推送分支并创建 PR。只对你已经允许写入的仓库启用这个规则。

1. 编辑 `repository.example.json`。

   ```json
   { "source": "C:/code/my-project", "base": "main" }
   ```

   `source` 指向已有本地仓库。`base` 使用本机已有分支或提交。准备步骤不拉取远端。需要最新代码时，先在原仓库更新该分支。

2. 编辑 `publish.example.json`，填写仓库名、远端和目标分支。

   `branch` 保留 `codex/work-{item}`。`{item}` 只接受执行器记录的工作项编号。`workflow-result.md` 是执行者编写、Reviewer 审查的 PR 正文。

3. 重新生成工作流配置，并复制到测试中台。

   ```powershell
   node .\examples\workflows\configure.ts $env:AGENT_AUTOLOOP_HOME
   Copy-Item "$env:AGENT_AUTOLOOP_HOME\rules.workflows.json" "$env:AGENT_AUTOLOOP_HOME\rules.json"
   ```

   生成器把两个 JSON 文件的内容嵌入命令参数。Central 在创建根工作流时记录这些参数。之后修改源文件不会改变这个根工作流的仓库或发布目标。

4. 在生成的 `rules.json` 中修改 `本地代码交付.prompt`，写明具体目标。

5. 把 `workflows.coding.steps.test.command` 改成项目已有的本机测试命令。

   默认是 `["npm", "test"]`。命令和参数分开填写。测试失败会返回原 Developer，之后重新经过两位 Reviewer。需要依赖安装时，在 `prepare` 后配置一个可信命令步骤；不要让事件决定要运行的命令。

6. 检查并启动规则。

   ```powershell
   node .\bin\agent-autoloop.ts check
   node .\bin\agent-autoloop.ts workflow start 本地代码交付
   ```

准备步骤创建 `codex/work-<工作项编号>` 工作树。原仓库的检出分支和未提交改动保持原样。提交步骤只在该工作树内提交。发布步骤要求工作树干净，并先记录待发布 commit。发布记录放在执行器的 context 文件旁，不污染项目。

发布步骤查询远端分支和已有 PR。推送或创建 PR 的响应丢失后，发布步骤读回远端结果。`--reconcile` 只查询；未确认时返回退出码 `3`，不会重复推送或创建 PR。远端分支出现其他 commit 时，步骤会阻塞，不强推覆盖。

这个模板已经审查并测试代码，不再套用旧交付插件的整套审查与 CI 流程。原有 `deliver` 标签方式仍可单独使用。示例不自动合并或关闭 Issue。

## 换成自己的流程

三个步骤类型是 `agent`、`command` 和 `workflow`。`next` 排顺序，`on` 根据明确结果跳转，`after` 等待汇合。每个循环步骤填写 `maxAttempts`。根 `budget` 累计子项、审查、修复和重试，不因新建 thread 清零。

`drdr` 中两位 Reviewer 都走向 `assess`。`assess.after` 指向两位 Reviewer。只有汇总步骤能返回 `develop`。Review 的工作流结果格式如下：

````text
需要修改。

```agent-autoloop-workflow
{"decision":"revise","output":{"findings":["说明缺少退出步骤"]}}
```
````

`recursive_prdr` 的计划格式如下。子项只能引用 `children.templates` 中允许的模板：

```json
{
  "output": {
    "children": [
      { "id": "install", "template": "single", "goal": "写安装说明", "input": { "accept": "列出安装、验证与卸载" } },
      { "id": "usage", "template": "drdr", "after": ["install"], "goal": "写日常使用说明", "input": { "accept": "引用安装结果，给出运行和退出步骤" } }
    ]
  }
}
```

计划只是资料。计划不能指定目录、命令、凭据或权限。运行开始后采用已记录的定义；修改配置只影响新的根工作流。

Issue 读取、创建、结果回写、合并和关闭也可配置成可信 `command`。读取步骤可调用 `gh issue view`。写入步骤应使用稳定工作项标记，并配置 `reconcile` 查询同一对象。先核对已有对象或状态，再决定是否需要写入。不要把事件内容拼接成命令，也不要把旧卡片回答当作新写入操作的授权。

## 验证范围

`tests/workflow-examples.test.ts` 检查配置、双 Reviewer 汇总、无 Git 数据流程和独立工作树恢复。数据流程经过真实 Central 步骤准入并生成文件。`tests/workflow-publish.test.ts` 检查响应丢失、只读核对和原生 Git 推送到临时本地远端。

这些测试不向真实 GitHub 创建 PR，也不证明模型缓存命中。真实 Codex CLI 的工作流验证结果见本次交付报告。
