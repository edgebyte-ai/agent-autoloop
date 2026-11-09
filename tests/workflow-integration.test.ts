// Failure modes: the real worker cannot execute Central's admissions; local command output is lost between steps;
// a non-coding workflow needs a repository or marks one step done as the complete goal.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";
import { empty, evolve, rows } from "../kernel/evolve.ts";
import { decide } from "../kernel/decide.ts";

const home = setup("workflow-integration");
const { createWorker } = await import("../worker/worker.ts");
test("the real worker runs and exports a non-coding workflow through the existing scheduler", async () => {
  let view = empty();
  const act = (type: string, ...args: unknown[]) => {
    const result = decide(view, { type, args }, Date.now(), {
      secret: "workflow-integration",
      publicUrl: "https://test.invalid",
    });
    view = evolve(view, result.facts);
    return result.value;
  };
  const write = join(home, "write.mjs");
  const exportFile = join(home, "export.mjs");
  writeFileSync(
    write,
    `import {writeFileSync} from 'node:fs'; writeFileSync('draft.txt', '小型非代码工作流'); console.log('草稿完成'); console.log('\x60\x60\x60agent-autoloop-workflow\\n'+JSON.stringify({output:{file:'draft.txt'}})+'\\n\x60\x60\x60');`,
  );
  writeFileSync(
    exportFile,
    `import {readFileSync,writeFileSync} from 'node:fs'; const c=JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT,'utf8')); if(!c.workflow.outputs.write) throw new Error('prior output missing'); writeFileSync('result.txt',readFileSync('draft.txt')); console.log('导出完成'); console.log('资料'.repeat(200000));`,
  );
  act("rules", {
    timezone: "UTC",
    askFirst: [],
    sources: { app: { name: "测试来源" } },
    channels: {},
    elsewhere: [],
    agents: {
      command: { name: "本机命令", worker: "local", use: "command", command: [process.execPath], access: "edit" },
    },
    workflows: {
      document: {
        start: "write",
        to: "command",
        roles: {},
        budget: { turns: 1, activeMs: 120_000, concurrency: 1, depth: 0, children: 0 },
        steps: {
          write: { kind: "command", command: [process.execPath, write], maxAttempts: 1, next: "export" },
          export: { kind: "command", command: [process.execPath, exportFile], maxAttempts: 1 },
        },
      },
    },
    rules: [
      {
        name: "document",
        when: { source: "app", types: ["new"] },
        to: "command",
        cwd: join(home, "items", "{item}"),
        workflow: "document",
        group: "document",
        tell: "needed",
      },
    ],
  });
  act("ingest", "app", { id: "goal", type: "new", subject: "goal" });
  const worker = createWorker({
    name: "local",
    capacity: 2,
    wait: 0,
    hub: {
      work: async ({ claim, running, capacity }) => {
        act("heartbeat", "local", running);
        return { job: capacity ? act("claimNext", "local", claim) : null, cancel: [] };
      },
      started: async (run, token, body) => act("started", run, token, body),
      result: async () => {
        throw new Error("workflow must not finish through the ordinary result door");
      },
      workflowAdvance: async (run, token, body) => act("workflowAdvance", run, token, body),
    },
  });
  try {
    const deadline = Date.now() + 90_000;
    while (rows(view, "workflows")[0]?.state !== "done" && Date.now() < deadline) {
      await worker.tick();
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const item = rows(view, "workflows")[0];
    assert.equal(item.state, "done", JSON.stringify(item));
    assert.equal(readFileSync(join(home, "items", String(item.id), "result.txt"), "utf8"), "小型非代码工作流");
    assert.equal(existsSync(join(home, "items", String(item.id), ".git")), false);
    const executions = rows(view, "workflow_steps");
    assert.deepEqual(
      executions.map((entry) => [entry.step, entry.state]),
      [
        ["write", "done"],
        ["export", "done"],
      ],
    );
    const reported = executions[1].result.output;
    assert.equal(typeof reported.artifact, "string");
    assert.equal(typeof reported.log, "string");
    assert.equal(readFileSync(reported.log, "utf8"), `导出完成\n${"资料".repeat(200000)}\n`);
    assert.ok(Buffer.byteLength(JSON.stringify(executions[1].result)) < 1024 * 1024);
    assert.equal(item.usage.turns, 0);
    assert.equal(worker.entries().length, 0);
  } finally {
    await worker.close();
    view.close();
  }
});
