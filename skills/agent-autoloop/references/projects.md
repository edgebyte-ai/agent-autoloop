# 项目与开发任务

本手册随 Skill 分发，不依赖操作机有源码。中台保存规则，worker 保存代码并运行步骤。下面的程序目录、模板和脚本都在目标 worker 的已安装程序包内。项目文件和配置通过授权的远程入口修改；已有工作流的启动、查询和控制可直接用 [MCP](mcp.md)。CLI 示例在有本人身份的中台或管理机运行，只有 worker 密钥不能执行管理操作。

## 新建项目

1. 从用户要求确定项目目录、技术栈、目标和验收条件。已有决定直接沿用；没有决定的产品功能不要自行扩写。
2. 在选定 worker 上创建项目目录，将需求写进项目文件。需要 coding 模板时，建立 Git 仓库及有初始提交的基线分支。
3. 需要创建 PR 时使用用户指定的远端仓库；新建远端仓库、推送和发布要有对应授权。只做本地开发不要求 GitHub。
4. 按下一节配置项目专用工作流。新项目的目标应包含可运行的启动命令和测试入口，测试步骤与所选技术栈一致。
5. 用户已经要求开始开发时，配置通过后启动任务，并回报工作项编号。

例如在 Linux worker 上初始化本地仓库：

```bash
mkdir -p "$HOME/code/my-app"
cd "$HOME/code/my-app"
git init -b main
printf '# 项目目标\n\n在这里填写已确定的需求与验收条件。\n' > README.md
git add README.md
git commit -m "初始化项目"
```

已有项目跳过初始化。不要覆盖已有仓库或把未提交的改动纳入任务；基线使用用户选定的本地分支或提交。coding 准备步骤不会自动拉取远端，需最新 main 时先更新本地基线。

## 定制项目工作流

coding 模板是准备工作树、开发、双 Reviewer、汇总、测试、提交、推送分支和创建 PR；不自动合并、关闭 Issue 或上线。普通配置按本节操作即可，不需要读协议或仓库文档。

1. 在 worker 的程序目录中配置 `examples/workflows/repository.example.json` 和 `publish.example.json`。前者写固定本地仓库和基线，后者写已授权的远端、目标分支和 PR 参数。不要从任务文字取得这些配置。

   `repository.example.json` 示例，目录属于 worker：

   ```json
   { "source": "/home/dev/code/my-app", "base": "main" }
   ```

   需要创建 PR 时，`publish.example.json` 示例：

   ```json
   {
     "repo": "YOUR_ACCOUNT/my-app",
     "remote": "origin",
     "branch": "codex/work-{item}",
     "base": "main",
     "title": "完成已审查的工作项",
     "bodyFile": "workflow-result.md"
   }
   ```

   只做本地开发时，不需要提供远端仓库；生成后按下面的本地模式说明移除发布步骤。

2. 在 worker 上运行生成器。默认安装目录的命令如下：

   ```bash
   node "$HOME/.agent-autoloop/app/examples/workflows/configure.ts" "$HOME/.agent-autoloop"
   ```

   非默认安装使用该机器实际的数据目录。生成器读取 worker 名称，将该机器的脚本绝对路径、仓库参数和 `workflows/{item}` 工作目录写进 `rules.workflows.json`。纯中台没有 worker 配置，不能在那里直接生成。

3. 将生成结果中的 `sources.workflow-demo`、`agents.author`、`agents.reviewer`、`workflows.coding` 和 `本地代码交付` 规则合并到中台的 `rules.json`。保留中台其他规则与通道，不整份覆盖。
4. 为项目取独立规则名和工作流名，并同步规则的 `workflow` 引用。多个项目不要共用会被另一项目改写的 `coding` 定义；Agent 定义在 worker 和权限相同时可复用。
5. 把规则 `prompt` 写成项目的固定开发约定，说明按本次事件资料中的需求和验收条件开发。模型和 effort 按用户选择写在 Agent 或角色上，不指定本机不存在的模型。
6. 将测试命令换成项目已有命令。参数数组如 `["npm", "test"]` 不经过 shell；需要组合命令时调用项目已有脚本。需要安装依赖时，在 `prepare` 后配置固定命令步骤，再接 `develop`。
7. 根据本次目标调整根预算和步骤次数。coding 默认累计 12 次 Agent 执行、1 小时活动时间、并发 2；开发最多 4 次，两位 Reviewer 各最多 4 次，所有执行共同消耗根预算。不要把这些上限说成无限修到完成。
8. 在中台运行 `agent-autoloop check`，保存后等待规则生效。修改 `config.json` 时重启对应机器的服务；仅改规则不需要重启。

只做本地提交时，删除 `steps.publish` 和 `steps.commit.next`，同步修改规则目标，仍保留测试和提交。Agent 的 `edit` 权限不能保证能写到 worktree 外的 Git 元数据；建工作树、提交和发布继续用模板的固定命令步骤，不为此给 Developer 扩大权限。命令步骤以 worker 的系统账号运行，不受 Agent 的 `access` 限制。

配置生成后，仓库与发布参数已嵌入命令；只修改两个 example JSON 文件不会改变中台规则。需要调整时重新生成并合并。程序升级可能替换 example 文件，项目的有效配置以中台规则为准。运行中的根工作流保留启动时的定义。

需要 Planner、计划审查或子项时，从 `recursive_prdr` 学习步骤与依赖，再为项目配置代码开发和集成步骤。现有递归示例产出文档，不是现成的递归 coding 模板。每个子项要有可信的独立目录，结果回父项整合；计划不能选择目录、命令或权限。

## 自定义步骤与并行

项目模板从 worker 程序包的 `examples/workflows/rules.json` 读取，不在操作机查仓库。只需单个 Agent 时，也可直接在中台 `rules.json.workflows` 增加下面的定义，角色引用已登记的 `author`：

```json
{
  "single": {
    "start": "work",
    "roles": { "developer": { "agent": "author", "prompt": "完成本次任务并核实结果。" } },
    "steps": { "work": { "kind": "agent", "role": "developer", "maxAttempts": 3 } },
    "budget": { "turns": 3, "activeMs": 1800000, "concurrency": 1, "depth": 0, "children": 0 }
  }
}
```

再让项目规则的 `workflow` 引用 `single`。规则仍要写 `name`、`when`、`to` 和可信 `cwd`；例如匹配已登记 `local` 来源的 `project.start` 事件，`to` 填 `author`，`prompt` 写固定要求。只有 `workflow` 定义不会自行启动。

| 配置 | 含义 |
| --- | --- |
| `kind: agent`、`role` | 调用一个角色；角色的 `agent` 引用顶层 Agent，可覆盖模型、effort、prompt 和 skill |
| `kind: command`、`command` | 在工作目录执行固定参数数组，不能从事件或模型结果取得命令 |
| `kind: workflow` | 按固定模板或允许的计划创建子项，等待子项后继续 |
| `next: "test"` | 本步完成后串行执行 test |
| `next: ["review1", "review2"]` | 分叉，两项可并行；要使用不同角色 |
| `after: ["review1", "review2"]` | 等两项都结束后再汇总 |
| `on: {"revise":"develop","pass":"test"}` | 按返回的明确决定分支；失败返回用 `failed` |
| `maxAttempts` | 本步骤最多执行次数，默认 1；配置返回修改时一起设置 |

先按 `on[decision]`、再按 `on[outcome]` 转移，最后才用成功时的 `next`。有 `on` 时，未知决定会阻塞。审查决定通过最后一条消息的结果块返回，例如：

````text
```agent-autoloop-workflow
{"decision":"revise","output":{"findings":["指出需要修改的问题"]}}
```
````

`worker.capacity` 限制普通任务与活动步骤的总数，`budget.concurrency` 限制本根工作流的活动步骤数。容量大于 1 只是允许并行；没有分叉时仍然串行。coding 的两位 Reviewer 是现成的并行例子。规则 `parallel` 还限制同组工作项的并发；子项并行需要这些上限一起允许。

修改任意步骤引用后运行 `agent-autoloop check`。命令有外部写入时配置 `reconcile`，使结果未知或退出失败时先读取实际结果；核对不清就阻塞，不重复写入。不要把有限预算写成无限循环。

## 启动已有项目的修复或功能开发

核对项目规则绑定的仓库、worker、基线和交付范围。`--subject` 只标识事项，不能选仓库；一条未写 `parallel` 的规则仍是一个事项。需要多个任务独立并行时，先配置规则 `parallel` 并核对 worker 容量。

在中台或管理机启动已经配置的规则，例如：

```bash
agent-autoloop workflow start my-app开发 \
  --subject issue-123 \
  --reason "修复登录后跳回首页的问题。验收：返回原目标地址，并补回归测试。"
```

新功能使用同一入口，填写本次范围和验收条件。`--reason` 最多 500 字，是提供给 Agent 的事件资料；固定指令仍来自规则。长需求先放到基线分支的项目文档，再引用它。

`workflow start` 回显执行轮编号。用 `workflow list` 取得工作项编号，后续 `show` 和控制命令使用工作项编号。不要把排队或一个步骤完成说成项目已交付。

## 查看、回答与停止

```text
agent-autoloop status
agent-autoloop workflow list
agent-autoloop workflow show <工作项编号> --json
agent-autoloop answer <卡片编号> <选项序号>
agent-autoloop workflow pause <工作项编号> --reason "检查当前产物"
agent-autoloop workflow resume <工作项编号>
agent-autoloop workflow cancel <工作项编号> --reason "终止任务"
```

回答采用用户已给出的选择，不代替用户做未授权的决定。提问中的 Agent 已结束本轮，等待期间不继续发模型请求。暂停阻止新步骤，已准入的步骤会收尾；取消后用 `show` 确认实际执行退出。普通任务用 `stop <执行轮编号>`，规则暂停用 `pause <规则名>`，不要混用三种编号和控制范围。

回报当前工作项、所在步骤、已完成产物、阻塞或问题以及下一步。PR 创建、合并、Ship 和生产健康验证各自如实报告，没有执行的部分不记为完成。
