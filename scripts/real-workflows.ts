// Failure modes: ordinary configured agents bypass the resident runtime; repair loses a role's thread; one turn is
// mistaken for a whole workflow; a non-code workflow needs Git; cleanup leaves a live turn or destroys recovery records.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { POWERSHELL } from "../host/command.ts";
import type { Checkpoint, Reading } from "../worker/agents.ts";

assert.equal(
  process.argv[2],
  "--run",
  "用法：node scripts/real-workflows.ts --run [结果.json] [documents]；会调用已登录的本机 Agent。",
);
assert.ok(
  process.argv[4] === undefined || process.argv[4] === "documents",
  "最后可写 documents，只核对非 coding 工作流",
);
const documentsOnly = process.argv[4] === "documents";
const temporary = process.platform === "win32" ? join(homedir(), "AppData", "Local", "Temp") : tmpdir();
const reportFile = resolve(process.argv[3] ?? join(temporary, `agent-autoloop-real-workflows-${Date.now()}.json`));
const home = mkdtempSync(join(temporary, "agent-autoloop-real-workflows-"));
let retain = false;

async function main() {
  const coding = join(home, "代码 工作区");
  const documents = join(home, "文档 工作区");
  mkdirSync(coding);
  mkdirSync(documents);
  process.env.AGENT_AUTOLOOP_HOME = home;
  process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
  delete process.env.AGENT_AUTOLOOP_PUBLIC_URL;

  if (!documentsOnly) execFileSync("git", ["init", "--quiet", coding], { stdio: "pipe" });
  writeFileSync(join(coding, "add.mjs"), "export const add = (a, b) => a - b;\n");
  writeFileSync(join(documents, "numbers.txt"), "3\n5\n9\n");
  writeFileSync(
    join(documents, "verify.mjs"),
    'import assert from "node:assert/strict"; import {readFileSync,existsSync} from "node:fs"; ' +
      'assert.equal(readFileSync("total.txt","utf8").trim(),"17"); assert.equal(existsSync(".git"),false); console.log("文件产物核对通过");\n',
  );

  const budget = { turns: 4, activeMs: 600_000, concurrency: 2, depth: 0, children: 0 };
  writeFileSync(
    process.env.AGENT_AUTOLOOP_RULES,
    JSON.stringify({
      sources: { manual: { name: "隔离真机测试" } },
      askFirst: [],
      agents: {
        writer: { name: "执行者", worker: "test", use: "codex", access: "edit", effort: "low", timeout: 3 },
        reviewer: { name: "审查者", worker: "test", use: "codex", access: "read", effort: "low", timeout: 3 },
      },
      channels: {},
      rules: [
        {
          name: "coding",
          when: { source: "manual", types: ["coding"] },
          to: "writer",
          cwd: coding,
          workflow: "coding",
        },
        {
          name: "documents",
          when: { source: "manual", types: ["documents"] },
          to: "writer",
          cwd: documents,
          workflow: "documents",
        },
      ],
      workflows: {
        coding: {
          start: "develop",
          roles: { developer: { agent: "writer" }, reviewer: { agent: "reviewer" } },
          budget,
          steps: {
            develop: {
              kind: "agent",
              role: "developer",
              maxAttempts: 2,
              prompt:
                "这是隔离的小型真实验证，只改当前工作目录，不联网、不提交、不发布。" +
                "第一次执行仅把 add.mjs 的 add(a,b) 修成数字加法，不创建测试文件。" +
                "收到审查后的第二次执行，读取资料中的审查意见，保留加法实现，创建 add.test.mjs，" +
                "用 node:test 和 node:assert/strict 验证 add(2,3)=5、add(-2,3)=1；运行该测试。" +
                "最后给出简短结论和工作流输出，output.artifacts 写相对文件名。",
              next: "review",
            },
            review: {
              kind: "agent",
              role: "reviewer",
              maxAttempts: 2,
              prompt:
                "独立读取当前目录的 add.mjs 与 add.test.mjs（若存在），不要改任何文件。" +
                "验收条件是 add 返回数字之和，且 add.test.mjs 同时覆盖正数加法和负数加法。" +
                "缺少测试时 decision=revise，output.notes 明确要求补上述两个 node:test 用例。" +
                "两项均满足时 decision=pass，并在 output.notes 记录核对结果。不要替执行者修改。",
              on: { revise: "develop", pass: "test" },
            },
            test: { kind: "command", command: [process.execPath, "--test", "add.test.mjs"], maxAttempts: 1 },
          },
        },
        documents: {
          start: "calculate",
          roles: { writer: { agent: "writer" } },
          budget: { ...budget, turns: 1 },
          steps: {
            calculate: {
              kind: "agent",
              role: "writer",
              maxAttempts: 1,
              prompt:
                "读取当前目录 numbers.txt 中每行的整数，计算总和，只把十进制整数和换行写入 total.txt。" +
                "这是文档数据工作流，不使用或创建 Git 仓库，不联网，不改其他文件。" +
                '最后用工作流输出报告 output.artifacts=["total.txt"]。',
              next: "verify",
            },
            verify: { kind: "command", command: [process.execPath, "verify.mjs"], maxAttempts: 1 },
          },
        },
      },
    }),
  );

  const { adapterFor } = await import("../worker/agents.ts");
  const adapter = await adapterFor("codex");
  assert.ok(adapter.open, "普通 use: codex 必须使用常驻适配器");
  const open = adapter.open;
  const operations = new Map<
    string,
    { id: string; session: string | null; cwd: string; result?: Reading; checkpoint?: Checkpoint }
  >();
  const pids = new Set<number>();
  const nativeProcesses: { pid: number; parent: number; name: string }[] = [];
  const logs: string[] = [];
  let connections = 0;
  adapter.open = async (options) => {
    connections++;
    const resident = await open(options);
    return {
      ...resident,
      async start(turn, checkpoint, persist) {
        const id = turn.id ?? turn.folder;
        if (!operations.has(id)) {
          assert.ok(operations.size < (documentsOnly ? 1 : 5), "真实测试的 Agent 执行轮额度已用完");
          operations.set(id, { id, session: turn.resume, cwd: turn.cwd });
        }
        const operation = operations.get(id)!;
        const result = await resident.start(turn, checkpoint, (saved) => {
          persist(saved);
          operation.checkpoint = saved;
          if (typeof saved.serverPid === "number" && !pids.has(saved.serverPid)) {
            pids.add(saved.serverPid);
            if (process.platform === "win32") {
              const processes = execFileSync(
                POWERSHELL,
                [
                  "-NoLogo",
                  "-NoProfile",
                  "-NonInteractive",
                  "-Command",
                  `$all = @(Get-CimInstance Win32_Process); $ids = [Collections.Generic.HashSet[int]]::new(); ` +
                    `[void]$ids.Add(${saved.serverPid}); do { $count = $ids.Count; ` +
                    `foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) } } ` +
                    `} while ($count -ne $ids.Count); @($all | Where-Object { $ids.Contains([int]$_.ProcessId) ` +
                    `-and $_.Name -like 'codex*' -and $_.CommandLine -match 'app-server' } | ` +
                    `ForEach-Object { @{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;name=$_.Name} }) | ConvertTo-Json -Compress`,
                ],
                { encoding: "utf8", windowsHide: true },
              );
              const found = JSON.parse(processes || "[]");
              nativeProcesses.push(...(Array.isArray(found) ? found : [found]));
            }
          }
        });
        operation.result = result;
        return result;
      },
    };
  };

  const hub = await import("../host/runtime.ts");
  const { serve } = await import("../host/http.ts");
  const { hubClient } = await import("../protocol/client.ts");
  const { createWorker } = await import("../worker/worker.ts");
  const server = serve(0);
  await new Promise((ready) => server.once("listening", ready));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = hubClient(url, hub.addKey("owner", "real-test"));
  const worker = createWorker({
    hub: hubClient(url, hub.addKey("worker", "test")),
    name: "test",
    wait: 0,
    capacity: 2,
    log: (line) => logs.push(line),
  });
  retain = true;
  const started = Date.now();
  const report: Record<string, unknown> = {
    platform: process.platform,
    node: process.version,
    machine: cpus()[0].model,
  };

  async function runWorkflow(rule: string) {
    const prior = new Set((await owner.workflows()).workflows.map((item: any) => item.id));
    await owner.run(rule);
    let itemId: number | undefined;
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      await worker.tick();
      if (itemId === undefined) {
        itemId = (await owner.workflows()).workflows.find((item: any) => !prior.has(item.id))?.id;
      }
      if (itemId !== undefined) {
        const tree = await owner.workflow(itemId);
        if (["failed", "blocked", "cancelled"].includes(tree.item.state))
          throw new Error(
            `${rule} ${tree.item.state}: ${tree.item.error ?? tree.item.reason ?? JSON.stringify(tree.executions.at(-1)?.result)}`,
          );
        if (tree.item.state === "done") return tree;
      }
      await delay(100);
    }
    throw new Error(`${rule} 超过十分钟`);
  }

  try {
    const problem = adapter.check?.();
    if (problem) throw new Error(problem);
    const code = documentsOnly ? undefined : await runWorkflow("coding");
    const document = await runWorkflow("documents");
    const trees = code ? [code, document] : [document];
    if (code) {
      const executionFor = (step: string) => code.executions.filter((execution: any) => execution.step === step);
      const developer = executionFor("develop");
      const reviewer = executionFor("review");
      assert.equal(developer.length, 2, "应实际经历一次开发修复");
      assert.equal(reviewer.length, 2, "应实际经历一次独立复审");
      assert.ok(developer[0].session);
      assert.equal(developer[0].session, developer[1].session, "修复应继续原执行者 thread");
      assert.equal(reviewer[0].session, reviewer[1].session, "复审应继续原审查者 thread");
      assert.notEqual(developer[0].session, reviewer[0].session, "角色 thread 必须独立");
      assert.equal(reviewer[0].result.decision, "revise");
      assert.equal(reviewer[1].result.decision, "pass");
      assert.equal(executionFor("test")[0].state, "done");
    }
    for (const execution of trees.flatMap((tree) => tree.executions)) {
      if (execution.kind === "agent") {
        assert.ok(execution.turn, "中台必须记录实际 Turn ID");
        assert.ok(
          [...operations.values()].some(
            (operation) =>
              operation.result?.session === execution.session && operation.checkpoint?.turnId === execution.turn,
          ),
          "中台的 thread/turn 应与实际执行记录一致",
        );
      }
    }
    assert.equal(readFileSync(join(documents, "total.txt"), "utf8").trim(), "17");
    assert.equal(existsSync(join(documents, ".git")), false);
    assert.equal(connections, 1, "多个工作流必须复用 worker 的连接");
    assert.equal(pids.size, 1, "多个工作流必须复用同一服务进程");
    if (process.platform === "win32") assert.equal(nativeProcesses.length, 1, "应实际运行一个原生 Windows app-server");
    assert.equal(operations.size, documentsOnly ? 1 : 5);
    report.completed = true;
    report.workflows = trees.map((tree) => ({
      id: tree.item.id,
      state: tree.item.state,
      executions: tree.executions.map((execution: any) => ({
        step: execution.step,
        attempt: execution.attempt,
        state: execution.state,
        role: execution.role,
        session: execution.session,
        turn: execution.turn,
        usage: execution.result?.usage,
        activeMs: execution.result?.activeMs,
        decision: execution.result?.decision,
      })),
    }));
  } catch (error) {
    report.completed = false;
    report.error = (error as Error).message;
    throw error;
  } finally {
    report.elapsedMs = Date.now() - started;
    report.connections = connections;
    report.serverPids = [...pids];
    report.nativeProcesses = nativeProcesses;
    report.agentOperations = operations.size;
    report.cacheNote = "进程与 thread 复用不证明模型缓存一定命中；费用未提供时保持未知。";
    report.observedTurns = [...operations.values()].map(({ checkpoint, result, session }) => ({
      thread: result?.session,
      turn: checkpoint?.turnId,
      previousThread: session,
    }));
    writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ report: reportFile, ...report }, null, 2));
    try {
      for (const item of (await owner.workflows()).workflows) {
        if (!["done", "failed", "cancelled"].includes(item.state)) await owner.workflowControl(item.id, "cancel");
      }
      const stopBy = Date.now() + 30_000;
      while (worker.entries().length && Date.now() < stopBy) {
        await worker.tick();
        await delay(100);
      }
    } finally {
      try {
        await worker.close();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        hub.db.close();
      }
    }
    if (worker.entries().length) throw new Error(`未能确认执行已退出，保留恢复记录：${home}`);
    retain = false;
  }
}

try {
  await main();
} finally {
  if (retain) console.error(`测试恢复记录尚未清理：${home}`);
  else rmSync(home, { recursive: true, force: true });
}
