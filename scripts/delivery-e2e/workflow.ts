// Exercise the shipped coding template; the harness only narrows its work and supplies a small reproducible repair.
import assert from "node:assert/strict";
import path from "node:path";
import { configure } from "../../examples/workflows/configure.ts";

type Options = {
  root: string;
  work: string;
  engine: string;
  repo: string;
  stamp: string;
  fixturePath: string;
  base: string;
};

export function workflowFixture({ root, work, engine, repo, stamp, fixturePath, base }: Options) {
  const config = configure(root, path.join(engine, "examples", "workflows"), "test");
  const rule = config.rules.find((rule: any) => rule.workflow === "coding");
  const flow = config.workflows.coding;
  const branch = `codex/e2e-${stamp}/workflow`;
  const bodyFile = `${fixturePath}/workflow-result.md`;
  const boundary =
    `这是隔离验收。只修改当前工作树内 ${fixturePath}/ 的文件，可以读取本轮资料文件中的审查意见。` +
    "不要改其他文件，不联网，不运行 Git、gh，不提交、推送、创建 PR 或调用其他 Agent。";
  config.sources = { e2e: { name: "真实交付验收" } };
  config.channels = {};
  config.askFirst = [];
  config.rules = [rule];
  config.workflows = { coding: flow };
  rule.name = "e2e-workflow";
  rule.when = { source: "e2e", types: ["workflow.start"] };
  rule.cwd = path.join(root, "工作流 工作区", "{item}");
  rule.prompt = "修复本次验收目录的加法函数，并由独立双人审查、本机测试和发布命令完成交付。";
  for (const agent of Object.values(config.agents) as any[]) {
    agent.timeout = 3;
    if (agent.use === "codex") agent.effort = "low";
  }
  flow.cwd = rule.cwd;
  flow.budget = { turns: 6, activeMs: 1_200_000, concurrency: 2, depth: 0, children: 0 };
  flow.roles.developer.prompt =
    boundary +
    ` 第一次执行只修复 ${fixturePath}/add.mjs，让 add(a,b) 返回数字之和；故意不创建测试文件。` +
    ` 在第二次执行中，读取两位审查者的全部意见，保留加法实现，创建 ${fixturePath}/add.test.mjs。` +
    "测试使用 node:test 和 node:assert/strict，分别验证 add(2,3)=5、add(-2,3)=1，并运行这个测试。" +
    ` 两次执行都更新 ${bodyFile}，写明实际修改和已验证、未验证的内容。最后输出简短结论。`;
  const review =
    `独立读取 ${fixturePath}/add.mjs、add.test.mjs（若存在）和 workflow-result.md。` +
    "验收条件：add返回数字之和；测试文件断言 add(2,3)=5、add(-2,3)=1；修改说明与事实一致。" +
    "缺少测试文件或任何条件未满足时输出 decision revise。output.findings 必须是字符串列表，不能放对象。" +
    '工作流结果块格式为 {"decision":"revise","output":{"findings":["需要修复的具体问题"]}}。' +
    '全部满足时格式为 {"decision":"pass","output":{"findings":[]}}。不要修改文件，不执行 Git、gh 或联网。';
  flow.roles.reviewer1.prompt = "你是第一位独立审查者，重点核对函数行为与测试断言。" + review;
  flow.roles.reviewer2.prompt = "你是第二位独立审查者，重点核对负数、遗漏的测试和修改说明。" + review;
  for (const name of ["develop", "review1", "review2", "assess"]) flow.steps[name].maxAttempts = 2;
  const repository = JSON.stringify({ source: work, base });
  flow.steps.prepare.command[flow.steps.prepare.command.length - 1] = repository;
  flow.steps.test.command = [process.execPath, "--test", `${fixturePath}/add.test.mjs`];
  flow.steps.test.maxAttempts = 1;
  const publisher = JSON.stringify({
    repo,
    remote: "origin",
    branch,
    base: "main",
    title: `交付验收 ${stamp}：工作流`,
    bodyFile,
  });
  flow.steps.publish.command[2] = publisher;
  flow.steps.publish.reconcile[2] = publisher;
  for (const step of Object.values(flow.steps) as any[]) {
    if (step.kind !== "command") continue;
    step.command[0] = process.execPath;
    if (step.reconcile) step.reconcile[0] = process.execPath;
  }
  return {
    config,
    repo,
    ruleName: rule.name as string,
    branch,
    fixtureFiles: { [`${fixturePath}/add.mjs`]: "export const add = (a, b) => a - b;\n" },
  };
}

export function verifyWorkflow(tree: any, expected: { repo: string; branch: string }) {
  assert.equal(tree.item.state, "done", "工作流还没有完成");
  const executions: any[] = tree.executions;
  assert.ok(
    executions.every((execution) => execution.state === "done"),
    "步骤没有全部完成",
  );
  const byStep = (name: string) =>
    executions.filter((execution) => execution.step === name).sort((a, b) => a.attempt - b.attempt);
  const threads: Record<string, string> = {};
  const turns = new Set<string>();
  for (const [step, role] of [
    ["develop", "developer"],
    ["review1", "reviewer1"],
    ["review2", "reviewer2"],
  ]) {
    const attempts = byStep(step);
    assert.deepEqual(
      attempts.map((execution) => execution.attempt),
      [1, 2],
      `${role} 必须实际执行初次和修复复审`,
    );
    assert.ok(attempts[0].session, `${role} 没有实际 thread`);
    assert.equal(attempts[1].session, attempts[0].session, `${role} 没有继续原 thread`);
    threads[role] = attempts[0].session;
    for (const execution of attempts) {
      assert.equal(execution.role, role);
      assert.ok(execution.turn, `${role} 缺少实际 Turn 编号`);
      turns.add(execution.turn);
    }
    if (step !== "develop")
      assert.deepEqual(
        attempts.map((execution) => execution.result.decision),
        ["revise", "pass"],
      );
  }
  assert.equal(new Set(Object.values(threads)).size, 3, "不同角色混用了 thread");
  assert.equal(turns.size, 6, "没有六次独立的实际 Turn");
  assert.equal(executions.filter((execution) => execution.kind === "agent").length, 6);
  assert.equal(tree.item.usage.turns, 6, "中台的累计轮数不符");
  const assessments = byStep("assess");
  assert.deepEqual(
    assessments.map((execution) => execution.result.decision),
    ["revise", "pass"],
  );
  const before = (completed: any, started: any) => {
    assert.ok(Date.parse(completed.finished_at) <= Date.parse(started.started_at), "后续步骤早于必需的前置步骤结束");
  };
  for (const [index, assessment] of assessments.entries()) {
    before(byStep("develop")[index], byStep("review1")[index]);
    before(byStep("develop")[index], byStep("review2")[index]);
    before(byStep("review1")[index], assessment);
    before(byStep("review2")[index], assessment);
  }
  before(assessments[0], byStep("develop")[1]);
  for (const name of ["prepare", "test", "commit", "publish"])
    assert.equal(byStep(name).length, 1, `${name} 执行次数不符`);
  before(assessments[1], byStep("test")[0]);
  before(byStep("test")[0], byStep("commit")[0]);
  before(byStep("commit")[0], byStep("publish")[0]);
  const publication = tree.item.outputs.publish.output;
  assert.ok(Number.isSafeInteger(publication.number) && publication.number > 0);
  assert.equal(publication.url, `https://github.com/${expected.repo}/pull/${publication.number}`);
  assert.equal(publication.branch, expected.branch);
  assert.match(publication.commit, /^[a-f0-9]{40}$/);
  assert.deepEqual(byStep("publish")[0].result.output, publication);
  return { item: tree.item.id, worker: tree.item.worker, threads, turns: [...turns], publication };
}
