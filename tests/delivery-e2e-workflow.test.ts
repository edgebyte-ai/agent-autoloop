// Failure modes: the live workflow bypasses the shipped coding template, cannot run native paths, or declares acceptance
// after one review while a role was replaced, a required repair was skipped, or the published commit is from another PR.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { workflowFixture, verifyWorkflow } from "../scripts/delivery-e2e/workflow.ts";
import { parseRules } from "../protocol/rules.ts";

const options = {
  root: path.resolve(".test-workflow"),
  work: path.resolve(".test-repository"),
  engine: path.resolve("."),
  repo: "example/test",
  stamp: "20261108-test",
  fixturePath: ".agent-autoloop-e2e/20261108-test/workflow",
  base: "a".repeat(40),
};

test("the acceptance config uses the real coding steps with six bounded role turns and literal native commands", () => {
  const fixture = workflowFixture(options);
  const config = parseRules(JSON.stringify(fixture.config), Date.now(), "UTC");
  const flow = config.workflows!.coding;
  assert.equal(flow.budget.turns, 6);
  assert.deepEqual(flow.steps.assess.after, ["review1", "review2"]);
  assert.equal(flow.steps.develop.maxAttempts, 2);
  assert.equal(flow.steps.review1.maxAttempts, 2);
  assert.equal(flow.steps.review2.maxAttempts, 2);
  assert.equal(flow.steps.publish.kind, "command");
  if (flow.steps.publish.kind !== "command") assert.fail();
  assert.equal(flow.steps.publish.command[0], process.execPath);
  assert.equal(JSON.parse(flow.steps.publish.command[2]).branch, fixture.branch);
  assert.equal(JSON.parse(flow.steps.publish.command[2]).bodyFile, `${options.fixturePath}/workflow-result.md`);
  assert.equal(flow.steps.prepare.kind, "command");
  if (flow.steps.prepare.kind !== "command") assert.fail();
  assert.deepEqual(JSON.parse(flow.steps.prepare.command.at(-1)!), { source: options.work, base: options.base });
  assert.deepEqual(Object.keys(fixture.fixtureFiles), [`${options.fixturePath}/add.mjs`]);
  assert.ok(Object.values(config.agents).every((agent) => agent.worker === "test"));
});

function completed() {
  let id = 0;
  const executions: any[] = [];
  const add = (step: string, attempt: number, role?: string, decision?: string) => {
    id++;
    executions.push({
      id,
      step,
      attempt,
      state: "done",
      kind: role ? "agent" : "command",
      role,
      session: role && `thread-${role}`,
      turn: role && `turn-${id}`,
      started_at: new Date(id * 1000).toISOString(),
      finished_at: new Date(id * 1000 + 500).toISOString(),
      result: { outcome: "done", ...(decision && { decision }) },
    });
  };
  add("prepare", 1);
  for (const attempt of [1, 2]) {
    add("develop", attempt, "developer");
    add("review1", attempt, "reviewer1", attempt === 1 ? "revise" : "pass");
    add("review2", attempt, "reviewer2", attempt === 1 ? "revise" : "pass");
    add("assess", attempt, undefined, attempt === 1 ? "revise" : "pass");
  }
  add("test", 1);
  add("commit", 1);
  add("publish", 1);
  const output = {
    number: 3,
    url: "https://github.com/example/test/pull/3",
    branch: workflowFixture(options).branch,
    commit: "b".repeat(40),
  };
  executions.at(-1).result.output = output;
  return {
    item: { id: 1, state: "done", worker: "test", usage: { turns: 6 }, outputs: { publish: { output } } },
    executions,
  };
}

test("acceptance checks repairs, independent persistent roles, completed joins and the exact publication", () => {
  const fixture = workflowFixture(options);
  const tree = completed();
  assert.equal(verifyWorkflow(tree, fixture).publication.number, 3);
  for (const alter of [
    (value: any) =>
      (value.executions.find((step: any) => step.step === "review2" && step.attempt === 2).session = "new-thread"),
    (value: any) =>
      (value.executions.find((step: any) => step.step === "review1" && step.attempt === 1).result.decision = "pass"),
    (value: any) =>
      (value.executions.find((step: any) => step.step === "assess").started_at = new Date(0).toISOString()),
    (value: any) =>
      (value.executions.find((step: any) => step.step === "review1").started_at = new Date(0).toISOString()),
    (value: any) => (value.item.outputs.publish.output.url = "https://github.com/other/test/pull/3"),
  ]) {
    const changed = structuredClone(tree);
    alter(changed);
    assert.throws(() => verifyWorkflow(changed, fixture));
  }
});

test("the configured local test command runs a scoped fixture in a native directory with spaces", () => {
  const temp = process.platform === "win32" ? path.join(homedir(), "AppData", "Local", "Temp") : tmpdir();
  const folder = mkdtempSync(path.join(temp, "autoloop-e2e-workflow-"));
  const workspace = path.join(folder, "工作 目录");
  const fixture = workflowFixture({ ...options, root: folder });
  const target = path.join(workspace, options.fixturePath);
  mkdirSync(target, { recursive: true });
  try {
    writeFileSync(path.join(target, "add.mjs"), "export const add = (a,b) => a+b;\n");
    writeFileSync(
      path.join(target, "add.test.mjs"),
      'import assert from "node:assert/strict"; import {test} from "node:test"; import {add} from "./add.mjs"; test("positive",()=>assert.equal(add(2,3),5)); test("negative",()=>assert.equal(add(-2,3),1));\n',
    );
    const command = fixture.config.workflows.coding.steps.test.command;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = execFileSync(command[0], command.slice(1), { cwd: workspace, encoding: "utf8", env });
    assert.match(result, /pass 2/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
