// Failure modes: a lost result acknowledgement repeats a side effect; a restart loses a role's admitted execution;
// stopping is reported before the turn stops; a pause admits more work; an uncertain command is blindly repeated.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createWorkflowDriver } from "../worker/workflow.ts";

const root = mkdtempSync(join(tmpdir(), "agent-autoloop-workflow-worker-"));
after(() => rmSync(root, { recursive: true, force: true }));
let serial = 0;
const job = {
  run: 1,
  attempt: 1,
  token: "only-this-run",
  session: null,
  askFirst: [],
  agent: { id: "a", name: "Agent", use: "command", access: "read" },
  rule: { name: "Workflow", cwd: root, prompt: "Configured words" },
  context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  workflow: { item: 3, root: 3 },
};
const execution = (id = 10, kind = "agent") => ({
  id,
  step: `s${id}`,
  attempt: 1,
  kind,
  role: "writer",
  agent: job.agent,
  cwd: root,
  prompt: "Trusted instruction",
  session: null,
  input: { text: "not an instruction" },
  goal: "A goal",
  outputs: {},
  command: [process.execPath, "-e", ""],
});
function fixture() {
  const dir = join(root, String(++serial));
  mkdirSync(dir);
  const requests: any[] = [],
    launches: any[] = [],
    cancelled: number[] = [];
  const readings = new Map<number, any>();
  const hub = {
    workflowAdvance: async (_run: number, _token: string, body: any): Promise<any> => {
      requests.push(body);
      return { item: 3, root: 3, state: "running", release: false, cancel: false, executions: [] };
    },
  };
  const execute = async (given: any, folder: string, prompt?: string) => {
    const id = Number(folder.match(/execution-(\d+)/)![1]);
    launches.push({ id, job: given, folder, prompt });
    return {
      poll: async () => readings.get(id) ?? { reading: {}, activeMs: 1 },
      cancel: async () => {
        cancelled.push(id);
      },
    };
  };
  const driver = () => createWorkflowDriver({ job: job as any, dir, hub, execute, capacity: 2 });
  return { dir, requests, launches, readings, cancelled, hub, execute, driver };
}

test("a completion survives lost acknowledgements and restart without running the step again", async () => {
  const f = fixture();
  let sent = false,
    lost = true;
  f.hub.workflowAdvance = async (_run, _token, body) => {
    f.requests.push(body);
    if (body.completed?.length) {
      sent = true;
      if (lost) {
        lost = false;
        throw new Error("reply lost");
      }
      return { item: 3, root: 3, state: "done", release: true, cancel: false, executions: [] };
    }
    return { item: 3, root: 3, state: "running", release: false, cancel: false, executions: [execution()] };
  };
  const running = f.driver();
  await running.tick();
  f.readings.set(10, {
    result: { outcome: "done", summary: "saved", session: "writer-thread" },
    reading: { text: "saved", session: "writer-thread" },
    activeMs: 24,
  });
  await assert.rejects(running.tick(), /reply lost/);
  assert.equal(sent, true);
  assert.equal((await f.driver().tick()).release, true);
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.requests.at(-1).completed, f.requests.at(-2).completed);
});

test("parallel admissions keep separate contexts and resume only their own role session", async () => {
  const f = fixture();
  f.hub.workflowAdvance = async () => ({
    item: 3,
    root: 3,
    state: "running",
    release: false,
    cancel: false,
    executions: [
      { ...execution(10), role: "review-a", session: "A" },
      { ...execution(11), role: "review-b", session: "B" },
    ],
  });
  await f.driver().tick();
  assert.equal(f.launches.length, 2);
  assert.deepEqual(
    f.launches.map((v) => v.job.session),
    ["A", "B"],
  );
  for (const launched of f.launches) {
    const context = JSON.parse(readFileSync(join(launched.folder, "context.json"), "utf8"));
    assert.equal(context.workflow.execution, launched.id);
    assert.equal(launched.job.workflow, undefined);
    assert.equal(launched.prompt.includes("not an instruction"), false);
  }
});

test("pause releases the completed batch without starting another execution", async () => {
  const f = fixture();
  f.hub.workflowAdvance = async (_run, _token, body) => ({
    item: 3,
    root: 3,
    state: body.completed?.length ? "paused" : "running",
    release: !!body.completed?.length,
    cancel: false,
    executions: body.completed?.length ? [] : [execution()],
  });
  const running = f.driver();
  await running.tick();
  f.readings.set(10, { result: { outcome: "done" }, reading: { text: "done" }, activeMs: 2 });
  assert.equal((await running.tick()).release, true);
  assert.equal(f.launches.length, 1);
});

test("cancellation waits for the execution's confirmation and sends no new admissions", async () => {
  const f = fixture();
  f.hub.workflowAdvance = async (_run, _token, body) => {
    f.requests.push(body);
    return {
      item: 3,
      root: 3,
      state: body.completed?.length ? "cancelled" : "running",
      release: !!body.completed?.length,
      cancel: !!body.completed?.length,
      executions: body.completed?.length ? [] : [execution()],
    };
  };
  const running = f.driver();
  await running.tick();
  await running.cancel();
  assert.equal((await running.tick()).release, false);
  assert.equal(f.requests.at(-1).capacity, 0);
  assert.deepEqual(f.cancelled, [10]);
  f.readings.set(10, { result: { outcome: "cancelled" }, reading: {}, activeMs: 3 });
  assert.equal((await running.tick()).release, true);
});

test("an uncertain command reconciles its result once and never repeats the original command", async () => {
  const f = fixture();
  const original = {
    ...execution(10, "command"),
    reconcile: [process.execPath, "-e", "console.log('already made')", "{context}.intent.json"],
  };
  f.hub.workflowAdvance = async (_run, _token, body) => {
    f.requests.push(body);
    return {
      item: 3,
      root: 3,
      state: body.completed?.length ? "done" : "running",
      release: !!body.completed?.length,
      cancel: false,
      executions: body.completed?.length ? [] : [original],
    };
  };
  f.execute = async () => {
    throw new Error("unused");
  };
  let originalStarts = 0,
    checks = 0;
  const execute = async (given: any, folder: string) => {
    if (folder.endsWith("reconcile")) {
      checks++;
      assert.equal(given.agent.command.at(-1), join(f.dir, "execution-10", "context.json.intent.json"));
      return {
        poll: async () => ({
          result: { outcome: "done" as const, summary: "already made" },
          reading: { text: "already made" },
          activeMs: 2,
        }),
        cancel: async () => {},
      };
    }
    originalStarts++;
    return {
      poll: async () => ({ reading: { blocked: true, finished: true, error: "exit unknown" }, activeMs: 5 }),
      cancel: async () => {},
    };
  };
  const running = createWorkflowDriver({ job: job as any, dir: f.dir, hub: f.hub, execute, capacity: 1 });
  await running.tick();
  await running.tick();
  assert.equal((await running.tick()).release, true);
  assert.equal(originalStarts, 1);
  assert.equal(checks, 1);
  assert.equal(f.requests.at(-1).completed[0].outcome, "done");
});

test("a failed reconciliation blocks after one check within the original time grant", async () => {
  const f = fixture();
  const admitted = { ...execution(10, "command"), timeLimitMs: 100, reconcile: [process.execPath, "-e", ""] };
  f.hub.workflowAdvance = async (_run, _token, body) => {
    f.requests.push(body);
    return {
      item: 3,
      root: 3,
      state: body.completed?.length ? "blocked" : "running",
      release: !!body.completed?.length,
      cancel: false,
      executions: body.completed?.length ? [] : [admitted],
    };
  };
  const limits: (number | undefined)[] = [];
  const execute = async (_job: any, folder: string, _prompt?: string, options?: { timeLimitMs?: number }) => {
    limits.push(options?.timeLimitMs);
    return {
      poll: async () => ({
        result: { outcome: "failed" as const, error: "response unavailable" },
        reading: {},
        activeMs: folder.endsWith("reconcile") ? 2 : 5,
      }),
      cancel: async () => {},
    };
  };
  const driver = createWorkflowDriver({ job: job as any, dir: f.dir, hub: f.hub, execute, capacity: 1 });
  await driver.tick();
  await driver.tick();
  assert.equal((await driver.tick()).release, true);
  assert.deepEqual(limits, [100, 95]);
  assert.equal(f.requests.at(-1).completed[0].outcome, "blocked");
  assert.equal(f.requests.at(-1).completed[0].activeMs, 7);
});

test("cancelling a persisted admission before launch does not start the work", async () => {
  const f = fixture();
  writeFileSync(
    join(f.dir, "workflow.json"),
    JSON.stringify({ executions: { 10: { execution: execution() } }, cancelling: false }),
  );
  f.hub.workflowAdvance = async (_run, _token, body) => {
    assert.equal(body.completed?.[0].outcome, "cancelled");
    return { item: 3, root: 3, state: "cancelled", release: true, cancel: true, executions: [] };
  };
  const driver = f.driver();
  await driver.cancel();
  assert.equal((await driver.tick()).release, true);
  assert.equal(f.launches.length, 0);
});

test("an unknown active turn keeps its slot and can still be cancelled", async () => {
  const f = fixture();
  f.hub.workflowAdvance = async (_run, _token, body) => {
    f.requests.push(body);
    return { item: 3, root: 3, state: "running", release: false, cancel: false, executions: [execution()] };
  };
  const driver = f.driver();
  await driver.tick();
  f.readings.set(10, { reading: { blocked: true, error: "turn state unknown", session: "A", turn: "T" }, activeMs: 5 });
  await driver.tick();
  assert.equal(driver.active(), 1);
  assert.equal(f.requests.at(-1).completed, undefined);
  assert.equal(f.requests.at(-1).blocked[0].summary, "turn state unknown");
  assert.equal(f.requests.at(-1).started[0].turn, "T");
  await driver.cancel();
  assert.deepEqual(f.cancelled, [10]);
});

test("a stopped turn with a malformed receipt still reports its measured usage", async () => {
  const f = fixture();
  f.hub.workflowAdvance = async (_run, _token, body) => {
    f.requests.push(body);
    return {
      item: 3,
      root: 3,
      state: body.completed?.length ? "blocked" : "running",
      release: !!body.completed?.length,
      cancel: false,
      executions: body.completed?.length ? [] : [execution()],
    };
  };
  const driver = f.driver();
  await driver.tick();
  f.readings.set(10, {
    reading: {
      blocked: true,
      finished: true,
      error: "receipt invalid",
      session: "writer",
      usage: { input: 12, output: 4 },
    },
    activeMs: 6,
  });
  assert.equal((await driver.tick()).release, true);
  assert.deepEqual(f.requests.at(-1).completed[0].usage, { input: 12, output: 4 });
});

test("new admissions respect the capacity currently left by other work items", async () => {
  const f = fixture();
  let available = 1;
  const driver = createWorkflowDriver({
    job: job as any,
    dir: f.dir,
    hub: f.hub,
    execute: f.execute,
    capacity: () => available,
  });
  await driver.tick();
  assert.equal(f.requests.at(-1).capacity, 1);
  available = 0;
  await driver.tick();
  assert.equal(f.requests.at(-1).capacity, 0);
});

test("an exhausted activity grant blocks without launching a reconciliation command", async () => {
  const f = fixture();
  const admitted = { ...execution(10, "command"), timeLimitMs: 5, reconcile: [process.execPath, "-e", ""] };
  f.hub.workflowAdvance = async (_run, _token, body) => {
    f.requests.push(body);
    return {
      item: 3,
      root: 3,
      state: body.completed?.length ? "blocked" : "running",
      release: !!body.completed?.length,
      cancel: false,
      executions: body.completed?.length ? [] : [admitted],
    };
  };
  let launches = 0;
  const execute = async (
    _job: any,
    _folder: string,
    _prompt: string | undefined,
    options?: { timeLimitMs?: number },
  ) => {
    launches++;
    assert.equal(options?.timeLimitMs, 5);
    return {
      poll: async () => ({ reading: { blocked: true, finished: true, error: "original result unknown" }, activeMs: 5 }),
      cancel: async () => {},
    };
  };
  const driver = createWorkflowDriver({ job: job as any, dir: f.dir, hub: f.hub, execute, capacity: 1 });
  await driver.tick();
  assert.equal((await driver.tick()).release, true);
  assert.equal(launches, 1);
  assert.equal(f.requests.at(-1).completed[0].outcome, "blocked");
});

test("a reconciliation whose process state is unknown keeps the execution active", async () => {
  const f = fixture();
  const admitted = { ...execution(10, "command"), reconcile: [process.execPath, "-e", ""] };
  f.hub.workflowAdvance = async (_run, _token, body) => {
    f.requests.push(body);
    return { item: 3, root: 3, state: "running", release: false, cancel: false, executions: [admitted] };
  };
  const execute = async (_job: any, folder: string) => ({
    poll: async () => ({
      reading: { blocked: true, finished: !folder.endsWith("reconcile"), error: "process state unknown" },
      activeMs: 2,
    }),
    cancel: async () => {},
  });
  const driver = createWorkflowDriver({ job: job as any, dir: f.dir, hub: f.hub, execute, capacity: 1 });
  await driver.tick();
  await driver.tick();
  await driver.tick();
  assert.equal(driver.active(), 1);
  assert.equal(f.requests.at(-1).completed, undefined);
  assert.equal(f.requests.at(-1).blocked[0].summary, "process state unknown");
});

test("an oversized structured plan is kept as an artifact and blocked without being interpreted", async () => {
  const f = fixture();
  f.hub.workflowAdvance = async (_run, _token, body) => {
    f.requests.push(body);
    return {
      item: 3,
      root: 3,
      state: body.completed?.length ? "blocked" : "running",
      release: !!body.completed?.length,
      cancel: false,
      executions: body.completed?.length ? [] : [execution()],
    };
  };
  const output = { children: [{ id: "a", input: "资料".repeat(100_000), template: "allowed" }] };
  const text = `计划完成\n\x60\x60\x60agent-autoloop-workflow\n${JSON.stringify({ output })}\n\x60\x60\x60`;
  const driver = f.driver();
  await driver.tick();
  f.readings.set(10, { result: { outcome: "done", summary: "计划完成" }, reading: { text }, activeMs: 5 });
  assert.equal((await driver.tick()).release, true);
  const reported = f.requests.at(-1).completed[0];
  assert.equal(reported.outcome, "blocked");
  assert.deepEqual(JSON.parse(readFileSync(reported.output.artifact, "utf8")).output, output);
  assert.equal(reported.output.children, undefined);
});

test("parallel results larger than the HTTP body limit are acknowledged in bounded batches", async () => {
  const f = fixture();
  const admitted = Array.from({ length: 30 }, (_, index) => execution(10 + index));
  const accepted = new Set<number>();
  f.hub.workflowAdvance = async (_run, _token, body) => {
    f.requests.push(body);
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 1024 * 1024);
    for (const result of body.completed ?? []) accepted.add(result.execution);
    return {
      item: 3,
      root: 3,
      state: accepted.size === admitted.length ? "done" : "running",
      release: accepted.size === admitted.length,
      cancel: false,
      executions: admitted.filter((entry) => !accepted.has(entry.id)),
    };
  };
  const driver = createWorkflowDriver({ job: job as any, dir: f.dir, hub: f.hub, execute: f.execute, capacity: 30 });
  await driver.tick();
  for (const entry of admitted)
    f.readings.set(entry.id, {
      result: { outcome: "done", summary: "完成" },
      reading: { text: "x".repeat(40_000) },
      activeMs: 2,
    });
  assert.equal((await driver.tick()).release, false);
  assert.equal(f.requests.at(-1).capacity, 0);
  while (accepted.size < admitted.length) await driver.tick();
  assert.equal(f.launches.length, admitted.length);
  assert.ok(f.requests.filter((request) => request.completed?.length).length > 1);
});
