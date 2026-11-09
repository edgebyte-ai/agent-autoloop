// Failure modes: a review proceeds before every required reviewer passes; the non-coding example needs a Git repository,
// drops an input occurrence, or exports a result that has not been checked against its input.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assess } from "../examples/workflows/assess.ts";
import { commitWork, prepare } from "../examples/workflows/repository.ts";
import { configure } from "../examples/workflows/configure.ts";
import { parseRules } from "../protocol/rules.ts";
import { decide } from "../kernel/decide.ts";
import { empty, evolve } from "../kernel/evolve.ts";
import { workflowContext, workflowResult } from "../worker/workflow-result.ts";

test("the supplied templates become valid rules with native paths and one worker per item", () => {
  const rules = configure(resolve(".workflow-demo"), resolve("examples/workflows"), "demo-worker");
  const parsed = parseRules(JSON.stringify(rules), Date.now(), "UTC");
  assert.ok(parsed.workflows?.single);
  assert.ok(parsed.workflows?.drdr);
  assert.ok(parsed.workflows?.recursive_prdr);
  assert.ok(parsed.workflows?.coding);
  assert.ok(parsed.workflows?.data);
  assert.ok(!JSON.stringify(parsed).includes("{examples}"));
  assert.ok(Object.values(parsed.agents).every((agent) => agent.worker === "demo-worker"));
});

test("generated coding commands freeze the trusted repository and publication settings", () => {
  const folder = mkdtempSync(join(tmpdir(), "agent-autoloop-workflow-config-"));
  try {
    for (const file of ["rules.json", "repository.example.json", "publish.example.json"])
      copyFileSync(resolve("examples/workflows", file), join(folder, file));
    const rules = configure(folder, folder, "demo-worker");
    const coding = rules.workflows.coding;
    const repository = JSON.parse(coding.steps.prepare.command.at(-1));
    const publisher = JSON.parse(coding.steps.publish.command[2]);
    writeFileSync(join(folder, "repository.example.json"), JSON.stringify({ source: "C:/another", base: "other" }));
    writeFileSync(join(folder, "publish.example.json"), JSON.stringify({ repo: "another/repository" }));
    assert.equal(JSON.parse(coding.steps.prepare.command.at(-1)).source, repository.source);
    assert.equal(JSON.parse(coding.steps.publish.command[2]).repo, publisher.repo);
    assert.equal(coding.steps.publish.reconcile[2], coding.steps.publish.command[2]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("review aggregation waits for every required verdict and carries every finding back to the developer", () => {
  const outputs = {
    review1: { decision: "pass", output: { findings: [] as string[] } },
    review2: { decision: "revise", output: { findings: ["计算遗漏重复出现的记录"] } },
  };
  assert.deepEqual(assess(outputs, ["review1", "review2"]), {
    decision: "revise",
    output: { findings: ["计算遗漏重复出现的记录"], reviewers: ["review1", "review2"] },
  });
  assert.throws(() => assess(outputs, ["review1", "missing"]), /missing/);
  outputs.review2 = { decision: "pass", output: { findings: [] } };
  assert.equal(assess(outputs, ["review1", "review2"]).decision, "pass");
});

test("the review command runs from the configured native path and publishes its verdict", () => {
  const folder = mkdtempSync(join(tmpdir(), "agent-autoloop-review-command-"));
  const context = join(folder, "context.json");
  try {
    writeFileSync(
      context,
      JSON.stringify({
        workflow: {
          outputs: {
            review1: { decision: "pass", output: { findings: [] } },
            review2: { decision: "revise", output: { findings: ["修复计算"] } },
          },
        },
      }),
    );
    const stdout = execFileSync(process.execPath, [resolve("examples/workflows/assess.ts"), "review1", "review2"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_AUTOLOOP_CONTEXT: context },
    });
    assert.match(stdout, /agent-autoloop-workflow/);
    assert.match(stdout, /"decision":"revise"/);
    assert.match(stdout, /修复计算/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the data pipeline calculates and checks every input occurrence without Git", () => {
  const folder = mkdtempSync(join(tmpdir(), "agent-autoloop-workflow-data-"));
  const script = resolve("examples/workflows/data.ts");
  try {
    writeFileSync(
      join(folder, "input.json"),
      JSON.stringify([
        { label: " 甲 ", value: 3 },
        { label: "甲", value: 3 },
        { label: "乙", value: 6 },
      ]),
    );
    for (const step of ["clean", "calculate", "check", "export"]) {
      execFileSync(process.execPath, [script, step], { cwd: folder, encoding: "utf8" });
    }
    assert.deepEqual(JSON.parse(readFileSync(join(folder, "result.json"), "utf8")), {
      count: 3,
      total: 12,
      average: 4,
    });
    writeFileSync(join(folder, "totals.json"), JSON.stringify({ count: 2, total: 9, average: 4.5 }));
    assert.throws(() => execFileSync(process.execPath, [script, "check"], { cwd: folder, stdio: "pipe" }));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("Central executes the supplied data definition through its final artifact", () => {
  const folder = mkdtempSync(join(tmpdir(), "agent-autoloop-workflow-data-central-"));
  let view = empty();
  let now = Date.now();
  const act = (type: string, ...args: unknown[]) => {
    const result = decide(view, { type, args }, now++, {
      secret: "workflow-example",
      publicUrl: "https://example.test",
    });
    view = evolve(view, result.facts);
    return result.value;
  };
  try {
    const config = configure(folder, resolve("examples/workflows"), "demo-worker");
    act("rules", parseRules(JSON.stringify(config), now, "UTC"));
    act("ingest", "workflow-demo", { id: "data-demo", type: "data.start" });
    const job = act("claimNext", "demo-worker", "data-demo-claim");
    let state = act("workflowAdvance", job.run, job.token, { capacity: 1 });
    while (state.executions.length) {
      const execution = state.executions[0];
      mkdirSync(execution.cwd, { recursive: true });
      const contextFile = join(folder, `context-${execution.id}.json`);
      writeFileSync(contextFile, JSON.stringify(workflowContext(job, execution)));
      const stdout = execFileSync(process.execPath, execution.command.slice(1), {
        cwd: execution.cwd,
        encoding: "utf8",
        env: { ...process.env, AGENT_AUTOLOOP_CONTEXT: contextFile },
      });
      const completed = workflowResult(execution, { outcome: "done", summary: stdout.split("\n")[0] }, stdout, 1);
      state = act("workflowAdvance", job.run, job.token, { completed: [completed], capacity: 1 });
    }
    assert.equal(state.state, "done");
    assert.equal(state.release, true);
    const item = view.get("workflows", job.workflow.item)!;
    assert.equal(item.outputs.export.outcome, "done");
    assert.deepEqual(JSON.parse(readFileSync(join(item.cwd, "result.json"), "utf8")), {
      count: 3,
      total: 12,
      average: 4,
    });
    assert.equal(item.usage.turns, 0);
  } finally {
    view.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("coding work items use a separate worktree and resume preparation or commit without duplicating work", () => {
  const folder = mkdtempSync(join(tmpdir(), "agent-autoloop-workflow-repo-"));
  const source = join(folder, "原项目");
  const workspace = join(folder, "工作项 7");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  mkdirSync(source);
  mkdirSync(workspace);
  try {
    git(source, "init", "-b", "main");
    git(source, "config", "user.name", "Workflow Test");
    git(source, "config", "user.email", "workflow@example.test");
    writeFileSync(join(source, "source.txt"), "原项目\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "initial");
    const original = git(source, "rev-parse", "HEAD");
    prepare(source, "main", workspace, 7);
    prepare(source, "main", workspace, 7);
    writeFileSync(join(workspace, "result.txt"), "工作项交付\n");
    const commit = commitWork(workspace, 7);
    assert.equal(commitWork(workspace, 7), commit);
    assert.notEqual(commit, original);
    assert.equal(git(source, "rev-parse", "HEAD"), original);
    assert.equal(git(workspace, "rev-list", "--count", "HEAD"), "2");
    assert.equal(git(workspace, "branch", "--show-current"), "codex/work-7");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
