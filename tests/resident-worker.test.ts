// Failure cases: a resident plugin falls back to one-shot commands, a finished run closes the shared connection, a
// restart forgets the checkpoint and repeats work, cancellation reaches another run, or an unknown result is retried.
// A completed result must survive a lost hub response without starting another turn; shared environments contain no run.
// Local admissions must not launch before polling or launch after cancellation; timeout must await actual interruption,
// and repairs cannot bypass Central's turn budget. Workflows and ordinary jobs share the same worker capacity.
// A finished command must not charge the time the worker was offline before collecting its result.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Job } from "../protocol/job.ts";
import type { WorkflowAdvance, WorkflowAdvanceResult, WorkflowExecution } from "../protocol/workflow.ts";
import { setup } from "./helpers.ts";

const home = setup("resident-worker");
const folder = join(home, "项目 with spaces");
const statsFile = join(home, "resident-events.jsonl");
mkdirSync(folder);
const plugin = join(home, "plugins", "resident-fixture");
mkdirSync(plugin, { recursive: true });
writeFileSync(
  join(plugin, "agent.ts"),
  `
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const home = ${JSON.stringify(home)};
const record = (event) => appendFileSync(join(home, "resident-events.jsonl"), JSON.stringify(event) + "\\n");
export default {
  command() { throw new Error("resident command must never run"); },
  read() { throw new Error("resident output must not use the one-shot reader"); },
  link: (session) => "fixture://" + session,
  open({ environment }) {
    record({ type: "open", run: environment.AGENT_AUTOLOOP_RUN, context: environment.AGENT_AUTOLOOP_CONTEXT });
    const active = new Map();
    return {
      async start(turn, checkpoint, persist) {
        const id = turn.command[0];
        const state = checkpoint ?? { id, session: turn.resume ?? "thread-" + id };
        state.reading = { session: state.session, started: true, progress: "正在处理 " + id };
        persist(state);
        record({ type: checkpoint ? "recover" : "start", id, session: state.session });
        if (turn.command[1] === "unknown") {
          return { ...state.reading, blocked: true, error: "结果未知，需要核对" };
        }
        return new Promise((resolve) => {
          let timer;
          const finish = (reading) => { clearInterval(timer); active.delete(id); record({ type: "finish", id }); resolve(reading); };
          active.set(id, { state, finish, deferred: turn.command[1] === "deferred-interrupt" });
          const check = () => {
            if (existsSync(join(home, id + ".stopped"))) {
              finish({ ...state.reading, finished: true, error: "实际执行已退出" });
              return;
            }
            if (existsSync(join(home, id + ".done"))) {
              let result = { ...state.reading, finished: true, text: "完成 " + id, usage: { input: 3, output: 2 } };
              if (turn.command[1] === "bad-receipt") result.text = "业务已完成\\n\\x60\\x60\\x60agent-autoloop\\n{坏}\\n\\x60\\x60\\x60";
              if (turn.command[1] === "missing-session") result = { session: state.session, finished: true, started: false, error: "原会话不存在" };
              persist({ ...state, reading: result });
              finish(result);
            }
          };
          timer = setInterval(check, 5);
          check();
        });
      },
      async interrupt(checkpoint) {
        record({ type: "interrupt", id: checkpoint.id });
        const pending = active.get(checkpoint.id);
        if (pending && !pending.deferred) pending.finish({ ...pending.state.reading, finished: true, error: "已中断" });
      },
      async close() {
        record({ type: "close" });
        for (const pending of active.values()) pending.finish({ ...pending.state.reading, blocked: true, error: "连接已关闭" });
      },
    };
  },
};
`,
);

const { createWorker } = await import("../worker/worker.ts");
let nextRun = 1;
const events = () =>
  existsSync(statsFile)
    ? readFileSync(statsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const count = (type: string, id?: string) =>
  events().filter((event) => event.type === type && (!id || event.id === id)).length;
const complete = (id: string) => writeFileSync(join(home, `${id}.done`), "");

function job(id: string, mode = "normal", session: string | null = null): Job {
  return {
    run: nextRun++,
    token: id,
    attempt: 1,
    session,
    askFirst: [],
    rule: { name: id, cwd: folder, prompt: `处理 ${id}` },
    agent: { id: "fixture", name: "测试", use: "resident-fixture", access: "edit", command: [id, mode] },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
}

function fakeHub() {
  const hub = {
    jobs: [] as Job[],
    results: [] as any[],
    starts: [] as any[],
    cancel: [] as number[],
    failResults: 0,
    async work(query: { capacity: boolean }) {
      const cancel = hub.cancel.splice(0);
      return { job: query.capacity ? hub.jobs.shift() : null, cancel };
    },
    async started(run: number, token: string, body: object) {
      hub.starts.push({ run, token, ...body });
    },
    async result(run: number, token: string, body: unknown) {
      if (hub.failResults > 0) {
        hub.failResults--;
        throw new Error("response lost");
      }
      hub.results.push({ run, token, ...(body as object) });
      return {};
    },
  };
  return hub;
}

type Worker = ReturnType<typeof createWorker> & { close?: () => Promise<void> };
async function until(worker: Worker, done: () => boolean) {
  const end = Date.now() + 2_000;
  while (!done()) {
    assert.ok(Date.now() < end, "resident worker did not reach the expected state");
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const worker = (hub: ReturnType<typeof fakeHub>): Worker =>
  createWorker({ hub: hub as any, name: "resident", wait: 0 });

test("completed jobs reuse one resident and their session without closing it", async (t) => {
  const hub = fakeHub();
  const before = { opens: count("open"), closes: count("close") };
  const first = job("reuse-one");
  complete("reuse-one");
  hub.jobs.push(first);
  const w = worker(hub);
  t.after(async () => {
    await w.close?.();
  });
  await until(w, () => hub.results.length === 1);
  assert.equal(hub.results[0].outcome, "done");
  hub.jobs.push(job("reuse-two", "normal", hub.results[0].session));
  complete("reuse-two");
  await until(w, () => hub.results.length === 2);
  assert.equal(count("open") - before.opens, 1);
  assert.equal(count("close") - before.closes, 0);
  assert.equal(hub.results[1].session, hub.results[0].session);
  const opened = events()
    .filter((event) => event.type === "open")
    .at(-1);
  assert.equal(opened.run, undefined);
  assert.equal(opened.context, undefined);
  assert.equal(typeof w.close, "function");
  await w.close!();
  assert.equal(count("close") - before.closes, 1);
});

test("a restarted worker recovers the saved operation instead of creating another", async (t) => {
  const hub = fakeHub();
  hub.jobs.push(job("restart"));
  const first = worker(hub);
  t.after(async () => {
    await first.close?.();
  });
  await until(first, () => count("start", "restart") === 1);
  assert.equal(hub.results.length, 0);
  assert.equal(typeof first.close, "function");
  await first.close!();
  const second = worker(hub);
  t.after(async () => {
    await second.close?.();
  });
  await until(second, () => count("recover", "restart") === 1);
  complete("restart");
  await until(second, () => hub.results.length === 1);
  assert.equal(count("start", "restart"), 1);
  assert.equal(hub.results[0].session, "thread-restart");
  assert.equal(hub.results[0].outcome, "done");
});

test("cancelling one resident turn leaves the other running on the same connection", async (t) => {
  const hub = fakeHub();
  const cancelled = job("cancel-one"),
    kept = job("keep-two");
  hub.jobs.push(cancelled, kept);
  const closes = count("close");
  const w = worker(hub);
  t.after(async () => {
    await w.close?.();
  });
  await until(w, () => count("start", "keep-two") === 1);
  hub.cancel.push(cancelled.run);
  await until(w, () => hub.results.some((result) => result.run === cancelled.run));
  assert.equal(hub.results.find((result) => result.run === cancelled.run).outcome, "cancelled");
  assert.equal(
    hub.results.some((result) => result.run === kept.run),
    false,
  );
  assert.equal(count("interrupt", "keep-two"), 0);
  assert.equal(count("close"), closes);
  complete("keep-two");
  await until(w, () => hub.results.some((result) => result.run === kept.run));
  assert.equal(hub.results.find((result) => result.run === kept.run).outcome, "done");
});

test("unknown resident results stay held and are never handed in as retryable failures", async (t) => {
  const hub = fakeHub();
  hub.jobs.push(job("unknown", "unknown"));
  const w = worker(hub);
  t.after(async () => {
    await w.close?.();
  });
  await until(w, () => count("start", "unknown") === 1);
  for (let i = 0; i < 4; i++) await w.tick();
  assert.equal(hub.results.length, 0);
  assert.equal(w.entries().length, 1);
  assert.equal(count("start", "unknown"), 1);
  assert.equal(count("recover", "unknown"), 0);
  // This test intentionally leaves an unresolved operation; remove only its fixture entry after the assertion.
  const [{ dir }] = w.entries();
  const { unlinkSync } = await import("node:fs");
  unlinkSync(join(dir, "entry.json"));
});

test("a result waiting for the hub is replayed after restart without another resident turn", async (t) => {
  const hub = fakeHub();
  hub.failResults = 2;
  hub.jobs.push(job("replay"));
  complete("replay");
  const first = worker(hub);
  t.after(async () => {
    await first.close?.();
  });
  await until(first, () => first.entries().some((entry) => entry.result !== undefined));
  assert.equal(hub.results.length, 0);
  await first.close?.();
  const second = worker(hub);
  t.after(async () => {
    await second.close?.();
  });
  await until(second, () => hub.results.length === 1);
  assert.equal(count("start", "replay"), 1);
  assert.equal(count("recover", "replay"), 0);
  assert.equal(hub.results[0].outcome, "done");
});

test("a local admission is lazy and cancellation before polling never launches it", async (t) => {
  const w = worker(fakeHub());
  t.after(async () => {
    await w.close();
  });
  const execution = await w.execute(job("local-lazy"), join(home, "local-lazy"), "执行这一条", { timeLimitMs: 100 });
  assert.equal(count("start", "local-lazy"), 0);
  await execution.cancel();
  const { result, activeMs } = await execution.poll();
  assert.equal(result?.outcome, "cancelled");
  assert.equal(activeMs, 0);
  assert.equal(count("start", "local-lazy"), 0);
});

test("a local time limit interrupts the admitted turn and waits for its actual exit", async (t) => {
  let clock = 1_000;
  const w = createWorker({ hub: fakeHub() as any, name: "local-timeout", wait: 0, now: () => clock });
  t.after(async () => {
    await w.close();
  });
  const execution = await w.execute(
    job("local-timeout", "deferred-interrupt"),
    join(home, "local-timeout"),
    undefined,
    { timeLimitMs: 100 },
  );
  await execution.poll();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(count("start", "local-timeout"), 1);
  clock += 101;
  await execution.poll();
  assert.equal((await execution.poll()).result, undefined);
  assert.equal(count("interrupt", "local-timeout"), 1);
  clock += 1_000;
  assert.equal((await execution.poll()).result, undefined, "an interrupt response is not proof the turn exited");
  writeFileSync(join(home, "local-timeout.stopped"), "");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const { result } = await execution.poll();
  assert.equal(result?.outcome, "failed");
  assert.match(result?.error ?? "", /已停止/);
  assert.equal(count("start", "local-timeout"), 1);
});

test("local bad receipts and missing sessions cannot start unreserved repair turns", async (t) => {
  const w = worker(fakeHub());
  t.after(async () => {
    await w.close();
  });
  for (const mode of ["bad-receipt", "missing-session"]) {
    const id = `local-${mode}`;
    complete(id);
    const execution = await w.execute(job(id, mode, "existing-session"), join(home, id));
    await execution.poll();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const outcome = await execution.poll();
    if (mode === "bad-receipt") {
      assert.equal(outcome.reading.blocked, true);
      assert.equal(outcome.reading.finished, true);
      assert.deepEqual(outcome.reading.usage, { input: 3, output: 2 });
      await execution.cancel();
      const cancelled = await execution.poll();
      assert.equal(cancelled.result?.outcome, "cancelled");
      assert.deepEqual(cancelled.result?.usage, outcome.reading.usage);
      assert.equal(cancelled.activeMs, outcome.activeMs);
    } else assert.equal(outcome.result?.outcome, "failed");
    await execution.poll();
    assert.equal(count("start", id), 1);
    assert.equal(count("recover", id), 0);
  }
});

test("workflow steps and ordinary jobs share one worker concurrency allowance", async (t) => {
  const ordinary = job("capacity-ordinary");
  const roots = [job("capacity-root-a"), job("capacity-root-b")];
  for (const root of roots) root.workflow = { item: root.run, root: root.run };
  const remaining = new Map<number, WorkflowExecution[]>();
  const admitted = new Map<number, WorkflowExecution[]>();
  for (const root of roots) {
    remaining.set(
      root.run,
      [1, 2].map((n) => ({
        id: root.run * 100 + n,
        step: `step-${n}`,
        attempt: 1,
        kind: "agent",
        role: `reviewer-${n}`,
        agent: { ...root.agent, command: [`${root.token}-${n}`, "normal"] },
        cwd: folder,
        session: null,
        input: null,
        outputs: {},
        goal: "并行处理",
      })),
    );
    admitted.set(root.run, []);
  }
  const base = fakeHub();
  base.jobs.push(...roots, ordinary);
  let claims = 0;
  const hub = {
    ...base,
    async work(query: { capacity: boolean }) {
      const result = await base.work(query);
      if (result.job) claims++;
      return result;
    },
    async workflowAdvance(run: number, _token: string, body: WorkflowAdvance): Promise<WorkflowAdvanceResult> {
      const completed = new Set((body.completed ?? []).map((result) => result.execution));
      const held = admitted.get(run)!.filter((execution) => !completed.has(execution.id));
      // Both root jobs arrive before either receives steps, like two ready work items on the hub.
      if (claims >= 2) held.push(...remaining.get(run)!.splice(0, body.capacity ?? 0));
      admitted.set(run, held);
      const release = held.length === 0 && remaining.get(run)!.length === 0;
      return { item: run, root: run, state: release ? "done" : "running", release, cancel: false, executions: held };
    },
  };
  const eventStart = events().length;
  const w = createWorker({ hub, name: "shared-capacity", capacity: 2, wait: 0 });
  t.after(async () => {
    await w.close();
  });
  const active = () => {
    const ids = new Set<string>();
    for (const event of events().slice(eventStart)) {
      if (event.type === "start") ids.add(event.id);
      if (event.type === "finish") ids.delete(event.id);
      assert.ok(ids.size <= 2, `worker capacity exceeded: ${[...ids].join(", ")}`);
    }
    return ids;
  };
  await until(w, () => active().size === 2);
  assert.equal(claims, 2);
  const deadline = Date.now() + 2_000;
  while (base.results.length === 0) {
    assert.ok(Date.now() < deadline, "shared capacity work did not finish");
    const [first] = active();
    assert.ok(first, "ready work must make progress");
    complete(first);
    await w.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await w.tick();
    active();
  }
  for (let n = 0; n < 10 && w.entries().length; n++) {
    for (const id of active()) complete(id);
    await w.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(claims, 3);
  assert.equal(w.entries().length, 0);
  assert.equal(
    events()
      .slice(eventStart)
      .filter((event) => event.type === "start").length,
    5,
  );
  active();
});

test("a finished command does not charge the worker's offline time when its result is recovered", async (t) => {
  let moment = 1_000;
  const w = createWorker({ hub: fakeHub(), name: "offline", now: () => moment, wait: 0 });
  t.after(() => w.close());
  const given = job("offline-command");
  given.agent = {
    id: "command",
    name: "命令",
    use: "command",
    access: "edit",
    command: [process.execPath, "-e", "console.log('done')"],
  };
  const dir = join(home, "offline-execution");
  const first = await w.execute(given, dir, "run", { timeLimitMs: 1_000 });
  await first.poll();
  const until = Date.now() + 20_000;
  while (!existsSync(join(dir, "exit-1"))) {
    assert.ok(Date.now() < until, "command did not exit");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  moment = 61_000;
  const recovered = await w.execute(given, dir, "run", { timeLimitMs: 1_000 });
  let result = await recovered.poll();
  while (!result.result) {
    assert.ok(Date.now() < until, "command tree did not exit");
    await new Promise((resolve) => setTimeout(resolve, 20));
    result = await recovered.poll();
  }
  assert.equal(result.result.outcome, "done");
  assert.ok(result.activeMs < 10_000, `offline waiting was charged as ${result.activeMs} active milliseconds`);
});
