// Failure mode: an external write succeeds, its CLI exits 1 after losing the response, and the failure edge repeats it.
// The configured reconciliation command must observe the first effect before Central can choose another step.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";
import { createWorkflowDriver } from "../worker/workflow.ts";
import type { Job } from "../protocol/job.ts";
import type { WorkflowCompletion, WorkflowExecution } from "../protocol/workflow.ts";

const home = setup("workflow-reconcile");
const { createWorker } = await import("../worker/worker.ts");
test("a command that wrote its result then exited 1 reconciles instead of taking the failure edge", async () => {
  const dir = join(home, "run");
  mkdirSync(dir);
  const effect = join(home, "effect.txt");
  const command = join(home, "write.mjs");
  const reconcile = join(home, "reconcile.mjs");
  writeFileSync(
    command,
    `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(effect)}, 'created\\n'); console.error('response lost'); process.exitCode=1;`,
  );
  writeFileSync(
    reconcile,
    `import {readFileSync} from 'node:fs'; if(readFileSync(${JSON.stringify(effect)}, 'utf8')!=='created\\n') process.exit(3); console.log('已核实原结果');`,
  );
  const job: Job = {
    run: 91,
    attempt: 1,
    token: "one-run",
    session: null,
    askFirst: [],
    workflow: { root: 1, item: 1 },
    agent: { id: "command", name: "命令", use: "command", access: "edit" },
    rule: { name: "外部写操作", cwd: home },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
  const execution: WorkflowExecution = {
    id: 9,
    step: "write",
    attempt: 1,
    kind: "command",
    cwd: home,
    session: null,
    command: [process.execPath, command],
    reconcile: [process.execPath, reconcile],
    input: {},
    outputs: {},
    goal: "核实副作用",
    timeLimitMs: 60_000,
  };
  const worker = createWorker({
    name: "local",
    hub: {
      work: async () => ({ job: null, cancel: [] }),
      started: async () => ({}),
      result: async () => ({}),
    },
  });
  let completion: WorkflowCompletion | undefined;
  const driver = createWorkflowDriver({
    job,
    dir,
    execute: worker.execute,
    capacity: 1,
    hub: {
      workflowAdvance: async (_run, _token, body) => {
        completion = body.completed?.[0] ?? completion;
        return {
          item: 1,
          root: 1,
          state: completion ? completion.outcome : "running",
          release: !!completion,
          cancel: false,
          executions: completion ? [] : [execution],
        };
      },
    },
  });
  try {
    const deadline = Date.now() + 40_000;
    while (!completion && Date.now() < deadline) {
      await driver.tick();
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(completion?.outcome, "done", JSON.stringify(completion));
    assert.equal(completion?.summary, "已核实原结果");
    assert.equal(readFileSync(effect, "utf8"), "created\n");
    assert.equal(readFileSync(join(dir, "execution-9", "exit-1"), "utf8").trim(), "1");
    assert.ok(completion!.activeMs! > 0);
  } finally {
    await worker.close();
  }
});
