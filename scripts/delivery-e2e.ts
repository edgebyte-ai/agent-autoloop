// Failure modes: real writes escape the named test repository, publication repeats after a lost reply,
// or native process cleanup reports success before execution stops. This opt-in runner never deletes a repository.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { cpus, homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Hub } from "../protocol/client.ts";

export function repositoryTarget(value: string) {
  const repo = value.replace(/^git@github\.com:/, "").replace(/\.git$/, "");
  assert.match(repo, /^[\w.-]+\/[\w.-]+$/, "测试仓库要写成 owner/name 或 git@github.com:owner/name.git");
  return { repo, remote: `git@github.com:${repo}.git` };
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

export function writeFixture(work: string, files: Record<string, string>) {
  for (const file of Object.keys(files)) assert.ok(!existsSync(join(work, file)), `测试文件已存在，未覆盖：${file}`);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, file)), { recursive: true });
    writeFileSync(join(work, file), text);
  }
}
export function removeFixture(work: string, stamp: string, files: Record<string, string>) {
  assert.match(stamp, /^[a-z0-9][a-z0-9-]*$/);
  const folder = `.agent-autoloop-e2e/${stamp}/`;
  const outside = Object.keys(files).filter((file) => !file.startsWith(folder));
  for (const file of outside) {
    if (existsSync(join(work, file)))
      assert.equal(readFileSync(join(work, file), "utf8"), files[file], `测试文件被别人修改，未清理：${file}`);
  }
  const inside = git(work, "ls-files", "-z", "--", folder).split("\0").filter(Boolean);
  git(work, "rm", "--ignore-unmatch", "--", ...inside, ...outside);
}
export async function removeTestLabels(
  api: (path: string, body?: unknown, method?: string) => Promise<any>,
  ownPulls: number[],
  created: string[],
) {
  for (const number of ownPulls) {
    const issue = await api(`issues/${number}`);
    for (const label of ["deliver", "deliver-attended"]) {
      if (issue.labels.some((item: any) => item.name === label))
        await api(`issues/${number}/labels/${label}`, undefined, "DELETE");
    }
  }
  const preserved: string[] = [];
  for (const label of created) {
    const uses = await api(`issues?state=all&labels=${encodeURIComponent(label)}&per_page=100`);
    if (!uses.length) await api(`labels/${label}`, undefined, "DELETE");
    else preserved.push(label);
  }
  return preserved;
}
export async function stopWorker<T extends { run: number }>(
  worker: { entries(): T[]; tick(): Promise<unknown>; close(): Promise<unknown> },
  cancel: (entry: T) => Promise<unknown>,
) {
  for (const entry of worker.entries()) await cancel(entry);
  const until = Date.now() + 90_000;
  while (worker.entries().length && Date.now() < until) {
    await worker.tick();
    if (worker.entries().length) await delay(100);
  }
  assert.equal(worker.entries().length, 0, "未能确认所有验收执行已退出，保留恢复记录");
  await worker.close();
}

export async function main(args = process.argv.slice(2)) {
  const [target, flag, output] = args;
  assert.ok(
    target && flag === "--run" && args.length <= 3,
    "用法：node scripts/delivery-e2e.ts <owner/name 或 SSH URL> --run [报告.json]",
  );
  const { repo, remote } = repositoryTarget(target);
  const stamp = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const temporary = process.platform === "win32" ? join(homedir(), "AppData", "Local", "Temp") : tmpdir();
  const root = mkdtempSync(join(temporary, "agent-autoloop-delivery-e2e-"));
  const work = join(root, "仓库 工作区");
  const home = join(root, "hub");
  const engine = resolve(dirname(process.argv[1]), "..");
  const reportFile = resolve(output ?? join(temporary, `agent-autoloop-delivery-e2e-${stamp}.json`));
  mkdirSync(home);
  mkdirSync(join(root, "temporary"));
  process.env.AGENT_AUTOLOOP_HOME = home;
  process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
  process.env.TEMP = process.env.TMP = join(root, "temporary");
  delete process.env.AGENT_AUTOLOOP_PUBLIC_URL;
  const { gh, github, pages } = await import("../plugins/delivery/github.ts");
  const { poll } = await import("../plugins/delivery/poll.ts");
  const { deliveryFixture } = await import("./delivery-e2e/delivery.ts");
  const { workflowFixture, verifyWorkflow } = await import("./delivery-e2e/workflow.ts");
  const api = github(repo);
  const report: any = {
    repo,
    remote,
    stamp,
    root,
    platform: process.platform,
    node: process.version,
    machine: cpus()[0].model,
    startedAt: new Date().toISOString(),
    passed: false,
    resources: { branches: [], pulls: [], labels: [], files: [] },
    healthKind: "真实 GitHub Ship 产物驱动的本机模拟健康服务；不是生产部署",
    stages: [],
    cleanup: {},
  };
  const save = () => writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
  const record = (stage: string, evidence: object = {}) => {
    const item = { stage, at: new Date().toISOString(), ...evidence };
    report.stages.push(item);
    save();
    console.log(JSON.stringify(item));
  };
  save();
  let hub: typeof import("../host/runtime.ts") | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let owner: Hub | undefined;
  let worker: ReturnType<(typeof import("../worker/worker.ts"))["createWorker"]> | undefined;
  let live = "0".repeat(40);
  let seeded = false;
  let fixtureFiles: Record<string, string> = {};
  let originalOpen: any[] = [];
  let originalBranches: any[] = [];
  const health = createServer((_req, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, commit: live }));
  });
  health.listen(0, "127.0.0.1");
  await once(health, "listening");
  const healthURL = `http://127.0.0.1:${(health.address() as any).port}/health`;
  const pluginBranch = `codex/e2e-${stamp}/delivery`;
  const fixturePath = `.agent-autoloop-e2e/${stamp}/workflow`;
  const plugin = deliveryFixture({ repo, runId: stamp, healthURL });
  const commit = (message: string) => {
    git(work, "-c", "user.name=Agent Autoloop Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
    return git(work, "rev-parse", "HEAD");
  };
  const push = (sha: string, branch: string) => {
    let failure: unknown;
    try {
      git(work, "push", "origin", `${sha}:refs/heads/${branch}`);
    } catch (error) {
      failure = error;
    }
    const observed = git(work, "ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0];
    if (observed !== sha) throw failure ?? new Error(`推送没有读回预期提交：${branch}`);
  };
  const findPull = async (branch: string) =>
    (
      await api(`pulls?state=all&head=${encodeURIComponent(repo.split("/")[0] + ":" + branch)}&base=main&per_page=100`)
    ).filter((p: any) => p.head.ref === branch && p.head.repo?.full_name === repo);
  const capturePR = async (branch: string) => {
    const found = await findPull(branch);
    assert.equal(found.length, 1, `本次分支应恰好对应一个 PR：${branch}`);
    const pr = found[0];
    if (!report.resources.pulls.some((item: any) => item.number === pr.number))
      report.resources.pulls.push({ number: pr.number, branch, head: pr.head.sha, url: pr.html_url });
    save();
    return pr;
  };
  try {
    const metadata = JSON.parse(gh(["repo", "view", repo, "--json", "isPrivate,defaultBranchRef,viewerPermission"]));
    assert.equal(metadata.isPrivate, true, "真实写入验收只使用已有私有测试仓库");
    assert.equal(metadata.defaultBranchRef.name, "main", "交付插件验收需要 main 作为默认分支");
    assert.ok(["ADMIN", "MAINTAIN", "WRITE"].includes(metadata.viewerPermission), "当前登录没有测试仓库写权限");
    originalOpen = await api("pulls?state=open&per_page=100");
    originalBranches = pages(repo, "branches?per_page=100");
    report.before = {
      main: (await api("git/ref/heads/main")).object.sha,
      openPulls: originalOpen.map((pr) => ({
        number: pr.number,
        head: pr.head.sha,
        branch: pr.head.ref,
        base: pr.base.ref,
        title: pr.title,
        labels: pr.labels.map((l: any) => l.name),
      })),
      branches: originalBranches.map((branch) => ({ name: branch.name, sha: branch.commit.sha })),
    };
    execFileSync("git", ["clone", "--no-tags", remote, work], { encoding: "utf8", stdio: "pipe", timeout: 60_000 });
    git(work, "config", "user.name", "Agent Autoloop Test");
    git(work, "config", "user.email", "test@example.invalid");
    git(work, "config", "core.autocrlf", "false");
    const initialFlow = workflowFixture({ root, work, engine, repo, stamp, fixturePath, base: "main" });
    fixtureFiles = { ...plugin.files, ...initialFlow.fixtureFiles };
    report.resources.files = Object.keys(fixtureFiles);
    writeFixture(work, fixtureFiles);
    git(work, "add", "--", ...Object.keys(fixtureFiles));
    const seed = commit(`test: prepare agent-autoloop e2e ${stamp}`);
    report.seed = seed;
    save();
    push(seed, "main");
    seeded = true;
    live = seed;
    record("fixture-prepared", { seed });
    const flow = workflowFixture({ root, work, engine, repo, stamp, fixturePath, base: seed });
    const publicationState = join(root, "publication.json");
    const faultEvidence = join(root, "publication-replies.jsonl");
    const publishStep = flow.config.workflows.coding.steps.publish;
    const publishConfiguration = publishStep.command[2];
    publishStep.command = [
      process.execPath,
      join(engine, "scripts/delivery-e2e/publish.ts"),
      publishConfiguration,
      publicationState,
      faultEvidence,
      JSON.stringify({ base: seed, folder: `.agent-autoloop-e2e/${stamp}`, remote }),
    ];
    publishStep.reconcile = [
      process.execPath,
      join(engine, "examples/workflows/publish.ts"),
      publishConfiguration,
      publicationState,
      "--reconcile",
    ];
    const config = flow.config;
    config.sources.github = { name: "交付来源" };
    config.agents.delivery = {
      name: "交付插件",
      worker: "test",
      use: "delivery",
      command: [repo, "--test-local-health"],
      access: "read",
      timeout: 20,
    };
    config.rules.push({
      name: "e2e-delivery",
      when: { source: "github", types: ["pull_request.*"] },
      to: "delivery",
      cwd: root,
      prompt: "按 main 的可信设置完成本次交付",
      parallel: 1,
    });
    writeFileSync(process.env.AGENT_AUTOLOOP_RULES!, JSON.stringify(config, null, 2));
    const { adapterFor } = await import("../worker/agents.ts");
    const adapter = await adapterFor("codex");
    const open = adapter.open!;
    const operations = new Map<string, any>();
    const nativeProcesses: any[] = [];
    const servicePids = new Set<number>();
    let connections = 0;
    adapter.open = async (options) => {
      connections++;
      const resident = await open(options);
      return {
        ...resident,
        async start(turn, checkpoint, persist) {
          const id = turn.id ?? turn.folder;
          if (!operations.has(id)) {
            assert.ok(operations.size < 6, "真实模型验收最多 6 个工作流 Turn");
            operations.set(id, { resume: turn.resume, cwd: turn.cwd });
          }
          const operation = operations.get(id)!;
          const result = await resident.start(turn, checkpoint, (saved) => {
            persist(saved);
            operation.checkpoint = saved;
            if (typeof saved.serverPid === "number" && !servicePids.has(saved.serverPid)) {
              servicePids.add(saved.serverPid);
              if (process.platform === "win32") {
                const system = process.env.SystemRoot ?? "C:\\Windows";
                const command = `$all=@(Get-CimInstance Win32_Process); $ids=[Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${saved.serverPid}); do {$n=$ids.Count; foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId)){[void]$ids.Add([int]$p.ProcessId)}}}while($n-ne$ids.Count); @($all|Where-Object {$ids.Contains([int]$_.ProcessId)-and $_.Name -like 'codex*'-and $_.CommandLine -match 'app-server'}|ForEach-Object {@{pid=[int]$_.ProcessId;name=$_.Name;parent=[int]$_.ParentProcessId}})|ConvertTo-Json -Compress`;
                const found = JSON.parse(
                  execFileSync(
                    join(system, "System32/WindowsPowerShell/v1.0/powershell.exe"),
                    ["-NoProfile", "-NonInteractive", "-Command", command],
                    { encoding: "utf8", windowsHide: true },
                  ) || "[]",
                );
                nativeProcesses.push(...(Array.isArray(found) ? found : [found]));
              }
            }
          });
          operation.result = result;
          return result;
        },
      };
    };
    const problem = adapter.check?.();
    if (problem) throw new Error(problem);
    hub = await import("../host/runtime.ts");
    const { serve } = await import("../host/http.ts");
    const { hubClient } = await import("../protocol/client.ts");
    const { createWorker } = await import("../worker/worker.ts");
    server = serve(0);
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    owner = hubClient(url, hub.addKey("owner", "test"));
    const source = hubClient(url, hub.addKey("source", "github"));
    const client = hubClient(url, hub.addKey("worker", "test"));
    let lostAck = false,
      restarted = false;
    const workerHub = {
      ...client,
      async workflowAdvance(run: number, token: string, body: any) {
        const answer = await client.workflowAdvance(run, token, body);
        if (!lostAck && body.completed?.some((result: any) => result.output?.branch === flow.branch)) {
          lostAck = true;
          record("workflow-result-ack-discarded", { run });
          throw new Error("验收注入：中台接受发布结果后丢弃响应");
        }
        return answer;
      },
    };
    const makeWorker = () =>
      createWorker({
        hub: workerHub,
        name: "test",
        wait: 0,
        capacity: 2,
        log: (line) => {
          report.workerLog ??= [];
          report.workerLog.push(line);
          console.log(line);
        },
      });
    worker = makeWorker();
    const knownLabels = new Set(pages(repo, "labels?per_page=100").map((label: any) => label.name));
    for (const label of ["deliver", "deliver-attended"])
      if (!knownLabels.has(label)) {
        report.resources.labels.push(label);
        save();
        await api("labels", { name: label, color: "5319e7" });
      }
    git(work, "switch", "-c", pluginBranch);
    writeFileSync(join(work, plugin.appPath), "版本二\n");
    git(work, "add", "--", plugin.appPath);
    const head = commit(`test: verify delivery ${stamp}`);
    report.resources.branches.push({ name: pluginBranch, sha: head });
    save();
    push(head, pluginBranch);
    const body = join(root, "delivery-pr.md");
    writeFileSync(body, `本次 ${stamp} 隔离验收：版本标记从版本一改成版本二。\n`);
    try {
      gh([
        "pr",
        "create",
        "--repo",
        repo,
        "--head",
        pluginBranch,
        "--base",
        "main",
        "--draft",
        "--title",
        `Autoloop E2E ${stamp} delivery`,
        "--body-file",
        body,
      ]);
    } catch (error) {
      if (!(await findPull(pluginBranch)).length) throw error;
    }
    const pull = await capturePR(pluginBranch);
    await api(`issues/${pull.number}/labels`, { labels: ["deliver", "deliver-attended"] });
    let events: any[] = [];
    for (let attempt = 0; attempt < 20 && !events.length; attempt++) {
      events = (await poll(repo)).filter(
        (event: any) => event.subject === `${repo}#${pull.number}` || event.subject === `#${pull.number}`,
      );
      if (!events.length) await delay(1000);
    }
    assert.equal(events.length, 1, "本次交付 PR 没有被来源识别");
    await source.event(events[0]);
    record("delivery-started", { number: pull.number, head });
    const deliveryEnd = Date.now() + 20 * 60_000;
    let delivered = false;
    while (Date.now() < deliveryEnd) {
      await worker.tick();
      const state = await owner.state();
      const failure = state.runs.find((run: any) => run.rule === "e2e-delivery" && run.error);
      if (failure) throw new Error(failure.error);
      const current = await api(`pulls/${pull.number}`);
      if (current.merged_at && live !== current.merge_commit_sha) {
        const runs = (
          await api(`actions/workflows/${plugin.shipWorkflow}/runs?head_sha=${current.merge_commit_sha}&event=push`)
        ).workflow_runs;
        const ship = runs.find(
          (run: any) =>
            run.head_sha === current.merge_commit_sha && run.status === "completed" && run.conclusion === "success",
        );
        if (ship) {
          const artifact = join(root, "ship-artifact");
          gh(["run", "download", String(ship.id), "--repo", repo, "--name", plugin.shipArtifact, "--dir", artifact]);
          const manifest = JSON.parse(readFileSync(join(artifact, "release-manifest.json"), "utf8"));
          assert.equal(manifest.runId, stamp);
          assert.equal(manifest.commit, current.merge_commit_sha);
          assert.equal(manifest.version, "版本二");
          live = manifest.commit;
          report.delivery = {
            number: pull.number,
            url: current.html_url,
            head,
            merged: current.merge_commit_sha,
            ship: ship.id,
            manifest,
            health: live,
          };
          record("ship-artifact-verified", report.delivery);
        }
      }
      if (state.runs.some((run: any) => run.rule === "e2e-delivery" && run.state === "done")) {
        assert.ok(report.delivery, "未核实 Ship 产物前不能报告完成");
        const statuses = (await api(`commits/${head}/status`)).statuses;
        for (const context of ["delivery", `autoloop-e2e-${stamp}-review`])
          assert.equal(statuses.find((s: any) => s.context === context)?.state, "success");
        assert.ok(!current.labels.some((label: any) => label.name === "deliver"));
        delivered = true;
        break;
      }
      if (state.cards.length)
        throw new Error(`交付产生阻塞卡片：${state.cards.map((card: any) => card.text).join("\n")}`);
      await delay(1000);
    }
    assert.ok(delivered, "交付插件未在 20 分钟内完成");
    record("delivery-passed", report.delivery);
    report.resources.branches.push({ name: flow.branch });
    save();
    const started = await owner.run(flow.ruleName);
    const workflowEnd = Date.now() + 20 * 60_000;
    let tree: any;
    while (Date.now() < workflowEnd) {
      await worker.tick();
      if (lostAck && !restarted) {
        await worker.close();
        worker = makeWorker();
        restarted = true;
        record("worker-recreated", { recovery: "同一 HOME 重建 worker 实例；不是操作系统强杀" });
      }
      const list = await owner.workflows();
      const item = list.workflows.find((item: any) => item.run === started.run);
      if (item) {
        tree = await owner.workflow(item.id);
        if (["blocked", "failed", "cancelled"].includes(tree.item.state))
          throw new Error(`工作流 ${tree.item.state}：${tree.item.reason}`);
        if (tree.item.state === "done" && restarted && !worker.entries().length) break;
      }
      await delay(150);
    }
    assert.equal(tree?.item.state, "done", "工作流没有在期限内完成");
    assert.ok(lostAck && restarted, "本次应实际丢弃结果确认并重建 worker");
    report.workflow = verifyWorkflow(tree, flow);
    const publication = await capturePR(flow.branch);
    const requested = JSON.parse(readFileSync(publicationState, "utf8"));
    assert.equal(publication.head.sha, requested.commit);
    assert.equal(publication.base.ref, "main");
    report.resources.branches.find((branch: any) => branch.name === flow.branch).sha = requested.commit;
    const mutationCount = () =>
      readFileSync(faultEvidence, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    assert.deepEqual(
      mutationCount()
        .map((event) => event.kind)
        .sort(),
      ["create", "push"],
    );
    execFileSync(publishStep.command[0], publishStep.command.slice(1), {
      cwd: tree.item.cwd,
      encoding: "utf8",
      timeout: 60_000,
      stdio: "pipe",
      windowsHide: true,
    });
    execFileSync(publishStep.reconcile[0], publishStep.reconcile.slice(1), {
      cwd: tree.item.cwd,
      encoding: "utf8",
      timeout: 60_000,
      stdio: "pipe",
      windowsHide: true,
    });
    assert.equal((await capturePR(flow.branch)).number, publication.number);
    assert.deepEqual(
      mutationCount()
        .map((event) => event.kind)
        .sort(),
      ["create", "push"],
    );
    assert.equal(connections, 1);
    assert.equal(servicePids.size, 1);
    if (process.platform === "win32") assert.equal(nativeProcesses.length, 1, "必须实际运行原生 Windows app-server");
    report.workflow.publication = {
      number: publication.number,
      url: publication.html_url,
      commit: requested.commit,
      branch: flow.branch,
    };
    report.workflow.recovery = {
      lostMutationReplies: mutationCount(),
      lostCentralAck: lostAck,
      workerInstanceRecreated: restarted,
      replayedWithoutWrites: true,
    };
    report.runtime = {
      connections,
      serverPids: [...servicePids],
      nativeProcesses,
      operations: [...operations.values()].map(({ resume, result, checkpoint }) => ({
        resume,
        session: result?.session,
        turn: checkpoint?.turnId,
        usage: result?.usage,
        sessionUsage: result?.sessionUsage,
      })),
    };
    record("workflow-passed", report.workflow);
    report.passed = true;
  } catch (error) {
    report.error = (error as Error).message;
    throw error;
  } finally {
    const errors: string[] = [];
    if (worker && owner) {
      try {
        await stopWorker(worker, async (entry) => {
          if (entry.job.workflow) {
            const item = (await owner!.workflow(entry.job.workflow.item)).item;
            if (!["done", "failed", "cancelled"].includes(item.state)) await owner!.workflowControl(item.id, "cancel");
          } else {
            const state = await owner!.state();
            const run = state.runs.find((run: any) => run.id === entry.run);
            if (run && ["queued", "claimed", "unknown"].includes(run.state)) await owner!.cancel(entry.run);
          }
        });
        report.cleanup.workerStopped = true;
      } catch (error) {
        report.passed = false;
        report.cleanup.errors = [String(error)];
        report.cleanup.retained = root;
        report.finishedAt = new Date().toISOString();
        save();
        throw new Error(`执行尚未确认退出，未清理远端或恢复目录：${root}；报告：${reportFile}`, { cause: error });
      }
    }
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done) => server!.close(() => done()));
    }
    hub?.db.close();
    health.closeAllConnections();
    await new Promise<void>((done) => health.close(() => done()));
    if (existsSync(join(work, ".git"))) {
      const ownPulls = new Set<number>(report.resources.pulls.map((pull: any) => pull.number));
      for (const resource of report.resources.branches) {
        try {
          const pulls = await findPull(resource.name);
          for (const pr of pulls) {
            ownPulls.add(pr.number);
            if (pr.state === "open") await api(`pulls/${pr.number}`, { state: "closed" }, "PATCH");
            assert.equal((await api(`pulls/${pr.number}`)).state, "closed");
          }
          const head = git(work, "ls-remote", "origin", `refs/heads/${resource.name}`).split(/\s/)[0];
          if (head) {
            if (resource.sha) assert.equal(head, resource.sha, "测试分支被别人修改，未删除");
            await api(`git/refs/heads/${resource.name}`, undefined, "DELETE");
            assert.equal(git(work, "ls-remote", "origin", `refs/heads/${resource.name}`), "");
          }
        } catch (error) {
          errors.push(`${resource.name}: ${error}`);
        }
      }
      if (report.seed) {
        try {
          git(work, "fetch", "origin", "main");
          git(work, "switch", "--detach", "origin/main");
          const observed = git(work, "ls-files", "--", "ops/delivery.json");
          seeded ||=
            observed.length > 0 &&
            readFileSync(join(work, "ops/delivery.json"), "utf8") === fixtureFiles["ops/delivery.json"];
          if (seeded) {
            removeFixture(work, stamp, fixtureFiles);
            if (git(work, "status", "--porcelain")) {
              const cleanup = commit(`test: remove agent-autoloop e2e ${stamp}`);
              push(cleanup, "main");
              report.cleanup.commit = cleanup;
            }
            assert.equal(
              git(
                work,
                "ls-tree",
                "-r",
                "--name-only",
                "HEAD",
                "--",
                `.agent-autoloop-e2e/${stamp}`,
                ...Object.keys(fixtureFiles).filter((file) => !file.startsWith(".agent-autoloop-e2e/")),
              ),
              "",
            );
            report.cleanup.filesRemoved = true;
          }
        } catch (error) {
          errors.push(`main fixture: ${error}`);
        }
      }
      try {
        report.cleanup.sharedLabelsPreserved = await removeTestLabels(api, [...ownPulls], report.resources.labels);
      } catch (error) {
        errors.push(`labels: ${error}`);
      }
      try {
        for (const original of report.before?.openPulls ?? []) {
          const current = await api(`pulls/${original.number}`);
          assert.deepEqual(
            {
              number: current.number,
              head: current.head.sha,
              branch: current.head.ref,
              base: current.base.ref,
              title: current.title,
              labels: current.labels.map((label: any) => label.name),
            },
            original,
            "已有 PR 发生变化",
          );
          assert.equal(current.state, "open");
        }
        const branches = new Map(
          pages(repo, "branches?per_page=100").map((branch: any) => [branch.name, branch.commit.sha]),
        );
        for (const branch of originalBranches)
          if (branch.name !== "main")
            assert.equal(branches.get(branch.name), branch.commit.sha, `已有分支发生变化：${branch.name}`);
        report.cleanup.existingResourcesPreserved = true;
      } catch (error) {
        errors.push(String(error));
      }
    }
    report.cleanup.errors = errors;
    report.finishedAt = new Date().toISOString();
    if (errors.length) report.passed = false;
    if (report.passed && !errors.length && (!worker || !worker.entries().length)) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        report.cleanup.localRemoved = true;
      } catch (error) {
        report.cleanup.errors.push(`本机恢复目录未删除：${root}: ${error}`);
        report.passed = false;
      }
    }
    if (!report.passed) {
      report.cleanup.retained = root;
      assert.ok(existsSync(root), "失败的验收必须保留本机诊断记录");
    }
    save();
    console.log(JSON.stringify({ passed: report.passed, report: reportFile, cleanup: report.cleanup }, null, 2));
    if (report.cleanup.errors.length) throw new Error(`验收清理未完成，详情见 ${reportFile}`);
  }
  return report;
}

if (import.meta.main) await main();
