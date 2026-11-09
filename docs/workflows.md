# 配置和运行工作流

工作流把步骤、返回修改、并行汇合和子工作项写进配置。中台执行这些规则并记录位置，Agent 只完成当前步骤。普通规则不变；只有规则写了 `workflow` 才启用工作流。

## 从示例开始

[示例目录](../examples/workflows/README.md)提供 `single`、双 Reviewer 的 `drdr`、`recursive_prdr`、非 coding 数据流程和本地 coding 流程。它们使用同一执行器，不是三套独立程序。

1. 复制示例中的 Agent、工作流定义和规则到自己的 `rules.json`。
2. 修改 worker 名、目录和本机命令。
3. 运行 `agent-autoloop check`。
4. 运行 `agent-autoloop workflow start <规则名>`。
5. 运行 `agent-autoloop workflow list` 查看根工作流。
6. 运行 `agent-autoloop workflow show <工作项编号>` 查看步骤和结果。

coding 示例中的发布步骤会推送分支并创建 PR。仅对已授权的测试仓库启用该步骤。文档和数据流程不需要 Git 仓库。

## 各个编号表示什么

| 名称 | 含义 |
|---|---|
| 根工作流 | 一次完整目标，包含累计预算和所有子工作项 |
| 工作项 | 一个有范围、输入和结果的执行单位，可包含子工作项 |
| 步骤 | 一次 Agent 调用、命令或子工作流 |
| 角色 | Developer、Reviewer、Planner 等身份，每个工作项内各有自己的会话 |
| 执行次数 | 同一步骤第几次实际尝试，包括修复、重试和回答后续办 |
| 执行编号 | 某次步骤执行的唯一编号，用于结果确认与恢复 |
| 运行轮编号 | 原有派单机制中的 run；工作项通过这个 run 交给 worker |

同一工作项的开发、审查、修复、测试和发布留在同一台 worker。明确拆分才创建子工作项。子工作项可通过可信模板指定另一台 worker；父项等待时释放执行名额，子项完成后回原 worker 集成。

## 配置结构

`rules.json` 顶层的 `workflows` 按名字保存定义。规则用 `workflow` 引用定义，同时保留 `when`、`to`、`cwd` 等原有字段。工作流、角色、步骤和子项的编号使用小写字母开头，之后可用小写字母、数字、`-` 和 `_`。

```json
{
  "workflows": {
    "single": {
      "start": "write",
      "roles": {
        "writer": { "agent": "codex", "prompt": "按资料中的目标写出结果。" }
      },
      "steps": {
        "write": { "kind": "agent", "role": "writer", "maxAttempts": 4 }
      },
      "budget": {
        "turns": 4,
        "activeMs": 1800000,
        "concurrency": 1,
        "depth": 0,
        "children": 0
      }
    }
  }
}
```

这是合入已有规则文件的片段。先在 `agents` 登记 `codex`，再让规则引用 `single`。完整可运行配置见示例。

| 定义字段 | 用法 |
|---|---|
| `start` | 第一步编号，或并行起始步骤的编号列表 |
| `roles` | 角色到已登记 Agent 的映射；角色可覆盖 `prompt`、`skill`、`model`、`effort` |
| `steps` | 以步骤编号为键的配置 |
| `budget` | 根工作流的累计限制 |
| `cwd` | 模板固定的工作目录；子工作流模板应提供 |
| `to` | 已登记的 Agent，确定工作项所属 worker；没有 Agent 角色的模板也要写 |

Agent 的权限和 worker 来自可信 `agents` 配置。一个工作项里的角色应属于同一 worker。运行开始时，中台保存定义、角色和 Agent 配置；后续修改 `rules.json` 不改变这次工作流。

### 三种步骤

| `kind` | 必需配置 | 执行内容 |
|---|---|---|
| `agent` | `role` | 调用该角色的 Agent；可写本步的 `prompt` 和 `skill` |
| `command` | `command` 参数数组 | 在工作项目录执行可信命令；可写 `reconcile` 核对结果不明的外部动作 |
| `workflow` | `template`、`children` 或 `planFrom` 三选一 | 创建子工作项并等待结果 |

共同字段：

| 字段 | 用法 |
|---|---|
| `next` | `done` 后继续的步骤编号或编号列表 |
| `on` | 按命名决定或结果状态返回其他步骤，例如 `{"revise":"develop","pass":"test","failed":"develop"}` |
| `after` | 本步要等待的其他步骤，用于并行汇合 |
| `maxAttempts` | 本步最多执行次数，默认 1；循环和重试不能超过此数 |
| `input` | 选择前序结果作为输入 |
| `output` | 声明产物名称 |

转移先查 `on[decision]`，再查 `on[outcome]`，最后才是在 `done` 时使用 `next`。没有隐式 `default`。失败未配置返回边时，工作项失败；执行器不会套用普通任务的失败自动重派。

`after` 只接受每个依赖步骤新一轮的结果，不能用上次审查让本次修复提前开始。`input` 引用的每项保留该步骤的完整结果和执行次数；`output` 是配置中的产物名称说明，不自动扫描或上传文件。

流程条件只有配置中的名字，没有任意表达式或脚本语言。命令仍是已有程序的参数数组。事件正文或模型输出不能替换程序路径、拼接 shell 命令或扩大权限。

### Agent 如何交结果

普通的一句话结果和 `agent-autoloop` 问题回执继续可用。需要审查决定、计划或结构化产出时，Agent 在最后一条消息附上：

````text
审查完成，需要修改错误处理。

```agent-autoloop-workflow
{
  "decision": "revise",
  "output": { "findings": ["读取失败时应保留已有文件。"] }
}
```
````

有 `on` 的步骤用 `decision` 选择配置允许的决定；未知决定会阻塞。需要决定却只交 `done`、且未配置 `on.done` 时，也会阻塞，不能据此绕过审查。没有 `on` 的 Reviewer 可把 `decision` 留作资料，由汇总步骤统一判断。`output` 始终是资料，不能增加命令、角色或权限。结果块读不懂时保留已完成输出并阻塞，避免为重写结果重复业务。

Agent 从本轮 `context.json` 读取 `workflow.goal`、`workflow.input` 和 `workflow.outputs`。外部事件、子项范围、旧结论、审查意见和回答都作为资料存入该文件，不直接拼进指令。

每次执行的 `output` 按 JSON 序列化后的 UTF-8 字节数计算大小。超过 48 KiB 时，worker 把完整结果存到本次执行目录的 `workflow-result.json`；Central 的 `output` 改为 `{artifact, log?, preview}`。`artifact` 和 `log` 是所属 worker 的本地路径，不是中台下载链接。命令的完整标准输出仍保存在 `log` 中。

普通文字超限不改变执行结果。结构化输出超限时，worker 同样保存原 JSON，但将工作项记为阻塞，不解析或执行超大的计划。并行完成的结果分批上报，HTTP 请求体的 1 MiB 上限不变。

### 审查和返回修改

`drdr` 示例在 Developer 完成后并行启动两位 Reviewer。汇总步骤的 `after` 指向两次审查；只有两位都结束，汇总才能运行。汇总输出 `revise` 时返回 Developer，输出 `pass` 时进入测试或交付。

Developer 修复继续自己的 thread；每位 Reviewer 复审继续自己的 thread。Planner 改计划也继续自己的 thread。不同工作项不共用角色会话。

### 子项、计划和重规划

固定子项可写 `children`，其中每项包含 `id`、`template`、可选的 `after`、`goal` 和 `input`。`after` 引用同一批子项的编号，依赖不能成环。

子项资料的 `input.dependencies` 包含已完成前置子项的 `{item, id, outputs}`。父项的 workflow 步骤在子项汇合后得到 `{id, state, outputs}` 数组，供集成步骤读取。子项结果只作为资料传递，不改变父项或其他子项的配置。

动态计划使用 `planFrom` 指向 Planner 步骤，并用 `templates` 列出允许的模板。计划保存在该步骤的 `output.children` 数组里。计划审查通过后，workflow 步骤才读取计划并创建子项。计划只能选择允许的模板、填写范围、输入和依赖；目录、命令、角色、凭据和权限仍来自可信定义。

重规划通过有次数上限的步骤返回实现。旧计划、审查意见和变更原因保留在每次执行记录中，不能覆盖成只有最新版计划。

## 观察和控制

```text
agent-autoloop workflow list
agent-autoloop workflow show 1
agent-autoloop workflow show 1 --json
agent-autoloop workflow pause 1 --reason "核对发布内容"
agent-autoloop workflow resume 1
agent-autoloop workflow cancel 1 --reason "目标已撤回"
```

这些编号是工作项编号。控制根项会作用于整棵工作项树；控制子项只作用于该子树。其他独立工作流继续运行。`workflow start <规则>` 复用原有立即运行接口，也接受 `--subject` 和 `--reason`。

`show` 展示根项、父子关系、依赖、所属 worker、目录、未完成步骤、角色会话、累计预算，以及每次执行的意见和结果。心跳只能说明 worker 还在线；最近实际进展来自步骤执行。一步 `done` 只代表该步骤完成，整个工作项还要满足后续步骤与子项的要求。

暂停阻止新的步骤、Turn、子项和外部动作准入。已经准入的步骤在明确的步骤边界收尾；状态会同时显示实际执行与暂停请求。暂停返回成功不能当作进程已停。

取消先发出请求，worker 中断该工作项的执行；确认执行结束后，中台才记录已取消。状态不明时保留未知或阻塞。恢复从未完成位置继续，已确认的步骤不会因恢复被重新执行。

需要人工回答时，Agent 交原有问题卡片并结束 Turn。工作项释放执行名额，不继续发模型请求；回答只交给提出问题的那次执行，不能用于后来的新动作。查看与回答仍用：

```text
agent-autoloop status
agent-autoloop answer <卡片编号> <选项序号>
```

## 预算和恢复

| `budget` 字段 | 口径 |
|---|---|
| `turns` | 根下已准入的 Agent 轮数，包括审查、修复、重试和回答后续办；启动状态未知也保留占用 |
| `activeMs` | 实际活动时间累计，单位毫秒 |
| `concurrency` | 根下同时准入执行的数量 |
| `depth` | 子工作项递归深度，根为 0 |
| `children` | 根下累计创建的子工作项数量 |

步骤的 `maxAttempts` 另限制循环和重试。子项不能重置根预算；同一执行的结果重放只确认一次，不重复计量。Token 和费用沿用已有用量格式；取不到的量保持未知。原有事件的 8 跳防环规则继续使用，工作流的递归和修复使用自己的预算。

`workflow show` 中根的 `usage` 累计整棵树。普通 `status` 的用量统计也包含各工作项已报的 Token 和费用，父项不再重复累计子项用量。普通统计的 `rounds` 仍按运行记录计数，不等于 Agent 步骤数；步骤轮数和角色明细查看工作流记录。`usage.turns` 在准入时预留，不只计算成功完成的次数。

根的 `budget.concurrency` 是额外上限，不能放宽原有规则组的 `parallel` 或 `worker.capacity`。子项也受这些上限约束。要让同组子项并行，规则的 `parallel` 至少设为 2，并给 worker 和根预算足够的名额。

中台在准入前从根的剩余活动时间中预留本步额度，并下发 `timeLimitMs`。worker 即使暂时断网，也按这个限额中断执行；完成后按实际时间结算，释放未用的预留。中断需要收尾时间，所以实际活动时间可能超过限额；超出的量照实记录，根项不再准入新步骤。这不是硬实时截止承诺。

工作流不使用普通任务内部的自动回执修复或静默新会话回退。每个新增 Agent Turn 都要重新经过中台准入，计入轮数、时间与执行次数。

中台事实日志是工作流状态的权威来源。worker 本地记录只用于恢复已准入执行、角色会话及尚未确认的结果，不另建调度数据库。

Codex worker 按需持有一份 app-server。已加载的 thread 直接开始下一 Turn，空闲卸载或进程重启后才 resume。默认空闲 120 分钟卸载 thread，Agent 的 `threadIdleMinutes` 可修改。等待时不发新模型请求，但共享进程可以驻留。进程复用和 thread 复用都不保证模型缓存命中。

请求发送前保存意图，收到 thread、turn 或结果后立即保存。worker 或 app-server 重启时，先核对已有执行：已经完成的只重新报告，仍在运行的继续观察，结果不明的保留阻塞。不能静默新建 thread 后声称继续了原会话。

命令的 `reconcile` 用于读取外部实际结果。原执行状态未知或命令失败退出时，worker 先运行一次核对命令；不能把非零退出码当作外部写入未发生的证明。例如创建 PR 的响应丢失后，按仓库和固定分支查询已有 PR，确认存在后回报完成。

核对未确认完成时保留阻塞，不盲目再发布，也不递归运行核对。核对时间计入原执行的剩余活动预算，原退出记录保留。示例中的发布辅助程序复用已有 GitHub 调用方式，不要求把旧交付插件的审查和 CI 再跑一次。

## HTTP、SSE 和 MCP

本人接口：

```text
GET  /v1/workflows
GET  /v1/workflows/<工作项编号>
POST /v1/workflows/<工作项编号>/pause   {"reason":"核对内容"}
POST /v1/workflows/<工作项编号>/resume  {}
POST /v1/workflows/<工作项编号>/cancel  {"reason":"目标撤回"}
```

列表返回 `{seq, workflows}`，详情返回 `{seq, root, item, items, executions}`。先读取快照的 `seq`，再用原有 `/v1/stream?after=<seq>` 继续读事实。

worker 用该 run 的 token 调用 `POST /v1/runs/<run>/workflow`，上报步骤开始、实际进展与结果，并领取下一批已准入步骤。其他 run 的 token 无权操作这个工作项。

MCP 对应 `workflow_list`、`workflow_show`、`workflow_start`、`workflow_pause`、`workflow_resume`、`workflow_cancel`，都要求本人身份。客户端可通过中台同端口的 `/mcp` 使用 Streamable HTTP 与 Bearer 密钥直接连接；stdio 使用本机配置的身份。工具不自动增加权限，连接示例见 [MCP 操作手册](../skills/agent-autoloop/references/mcp.md)。不要把本人 MCP 配进执行任务的 Agent 用户级配置。

完整数据约定见[协议](protocol.md)，插件生命周期见[插件开发说明](plugins.md#常驻-agent)。

## 真实运行记录

2026-11-08，在原生 Windows、Node 24.22.1、Codex CLI 0.167.0 上完成以下真实模型运行。模型沿用本机 CLI 配置，工作流使用 `effort: "low"`；测试使用临时数据目录、随机端口和无通知通道。

| 验证 | 实际结果 | 耗时 |
|---|---|---:|
| 普通 `use: "codex"` 问答 | 2 次 Turn，复用 1 个 app-server 连接和原 thread | 37.578 秒 |
| coding 与非 coding 全流程 | coding 用 4 次 Turn 完成开发、独立审查、原 Developer 修复、原 Reviewer 复审，再跑本机测试；非 coding 用 1 次 Turn 输出文件结果 `17`，工作目录没有 `.git`。5 次 Turn 共用 1 个原生 `codex.exe` | 226.319 秒 |
| 修复后的记录核对 | 非 coding 再跑 1 次 Turn，Central 的 thread/turn 与 checkpoint、CLI 记录一致；完整 Turn 用量与 4 条 `token_count` 更新核对一致 | 37.705 秒 |

全流程运行时发现了两处记录缺口：Central 的 turn 编号为空，用量只统计最后一次模型请求。代码修复后，第三项定点运行验证了两条记录路径。不能把第二项原报告的字段当作修复后正确性的证据。

第三项核对的完整 Turn 用量为 input 94983、output 392、cached 70528，费用未知。`cached` 只表示 CLI 实际报告的缓存用量，不保证其他运行必然命中缓存。运行完成后已关闭 worker，清理原生进程树和临时数据目录。

在已安装并登录 Codex 的专用测试环境中复现：

```text
node scripts/real-agents.ts codex
node scripts/real-workflows.ts --run report.json
node scripts/real-workflows.ts --run reporting.json documents
```

这些命令会使用本机模型额度。工作流脚本报告实际进程、thread、步骤和用量。以上三项运行没有向真实 GitHub 推送、创建或合并 PR，也没有发布；macOS 未做本次真机验证。上述记录不代表所有权限模式与故障场景都经过真实模型运行，自动化测试结果另看本次交付报告。

## 真实 GitHub 交付验收

`scripts/delivery-e2e.ts` 在同一次验收中运行交付插件和新 coding 工作流。Windows 直接使用原生 Node、Git、`gh` 和 Codex CLI；脚本不通过 WSL 代替原生运行。先在终端登录 GitHub 和 Codex，再使用临时数据目录与随机端口运行。脚本不发送真实通知。

**警告：只对已授权的专用私有测试仓库运行此脚本。** 脚本会向 main 提交测试文件，推送测试分支、创建 PR，并合并交付插件的测试 PR。脚本还会触发 GitHub Actions 和真实模型调用。

在本仓库根目录运行：

```powershell
node scripts/delivery-e2e.ts git@github.com:YOUR_ACCOUNT/autoloop-test.git --run report.json
```

也可以用 `YOUR_ACCOUNT/autoloop-test` 指定仓库。仓库应已存在，默认分支应为 main。当前账号应有推送、创建与合并 PR、运行 Actions 和清理本次分支的权限。仓库已有 `ops/delivery.json` 时，脚本拒绝覆盖。脚本不创建或删除整个仓库，也不改其他 PR 或分支。

| 路径 | 检查内容 |
|---|---|
| 交付插件 | 真实模型审查、草稿转 ready 后的完整检查、合并、Ship 成功和本机健康版本核对 |
| coding 工作流 | Developer 开发、两位 Reviewer 独立审查、汇合后修复、原角色 thread 复审、本机测试、推送固定 commit 和创建 PR |
| 写入恢复 | 真实推送和 PR 创建成功后丢弃响应，随后读取 GitHub 结果；再次执行与核对不新增提交或 PR |
| 中台回报恢复 | 中台收到发布结果后丢弃确认，再从同一数据目录重建 worker 实例，核对已完成结果与原 PR |

GitHub Actions 会生成本次 commit 的发布清单。控制器核实 Ship 成功后，才更新本机健康服务。这个健康服务是测试替身；通过验收不代表部署到了生产环境。worker 实例重建检查持久记录恢复，不代替操作系统进程强杀测试。

脚本按本次测试编号创建文件和分支。测试文件通过普通提交加入 main，结束后再用清理提交移除；main 的提交历史保留。脚本会关闭本次未合并的 PR，删除本次分支，并报告清理结果。检查报告中的 PR、commit、Actions、角色会话、恢复和清理记录；存在失败或未清理资源时，不把整次验收记为通过。

成功时，脚本删除本次本机数据目录，保留报告。失败时，脚本保留本机诊断文件，并在 `cleanup.retained` 写出完整目录。若不能确认执行已经停止，脚本保留中台、远端资源和本机目录，不继续清理。

### 2026-11-08 原生 Windows 实测

在原生 Windows、Node 24.22.1、Codex CLI 0.167.0 上，第三次验收通过。运行时间为美国太平洋时间 22:10:22–22:15:18，耗时 295.807 秒。仓库为私有测试仓库 `edgebyte-ai/agent_work_test`。

| 验证 | 实际结果 |
|---|---|
| 交付插件 | [PR #134](https://github.com/edgebyte-ai/agent_work_test/pull/134) 完成默认模型审查、完整检查和合并。合并提交为 `e892b528d273797c4d6bada537e6ec9e028a2666`。 |
| Ship | [Actions 运行 42571564772](https://github.com/edgebyte-ai/agent_work_test/actions/runs/42571564772) 成功。下载的发布清单、合并提交和本机健康版本一致。 |
| 新 coding 工作流 | [PR #135](https://github.com/edgebyte-ai/agent_work_test/pull/135) 交付提交 `795afdc3904f894ffd8af10c7c0ba63372bc1cd9`。Developer 和两位 Reviewer 共执行 6 次 Turn，使用 3 个独立 thread；修复和复审继续各自原 thread。 |
| 原生运行与恢复 | 工作流只启动 1 个原生 `codex.exe` app-server。真实推送和 PR 创建各执行 1 次，并分别丢弃成功响应。中台确认丢失后重建 worker 实例，重复发布和核对没有新增写入。 |
| 清理 | PR #135 已关闭且未合并；本次两个分支和 PR 交付标签已清理。本机测试进程已停止，成功运行的数据目录已删除。原有 PR #10、#13 保持原状。 |

清理提交为 `5b4339fe3e6b92ac3bd5a22975bc8a2da93f4506`。清理后的 main 文件树与本轮开工前相同；准备、合并和清理的提交历史仍然保留。

前两次真实运行发现的问题已修复：私有仓库抓取按命令使用 `gh` 认证；审查提示明确 `findings` 的文字字段；清理错误保留原业务失败；已关闭 PR 上的本次交付标签也会清理。第三次报告的 `passed` 为 true，`cleanup.errors` 为空。

本次自动化回归中，Windows 602 项通过、4 项按环境跳过；Linux 快速套件 812 项通过、30 项按平台跳过。类型检查和格式检查通过。成功运行的本机目录已删除；前两次失败运行的诊断目录仍保留，清理状态另列在本次交付报告。

这次实测覆盖真实 GitHub 写入和原生 Windows 主路径。健康端仍是本机模拟服务，worker 恢复仍是实例重建；没有把这些结果记为生产部署或操作系统强杀验收。
