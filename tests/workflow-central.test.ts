// Failure modes: step replay spends twice, reviews race a fix, a reload changes an active plan, and waiting holds capacity.
// Child scheduling must keep parents on their worker and cancellation must wait for admitted work to exit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { empty, evolve, rows, snapshot } from "../kernel/evolve.ts";
import { decide } from "../kernel/decide.ts";

const env = { secret: "workflow-tests", publicUrl: "https://hub.test" };
const agent = { name: "执行者", worker: "local", use: "command", command: ["node", "noop.js"], access: "edit" };
const definition = () => ({
  start: "develop",
  to: "developer",
  roles: { developer: { agent: "developer" }, r1: { agent: "reviewer" }, r2: { agent: "reviewer" } },
  budget: { turns: 20, activeMs: 100000, concurrency: 2, depth: 2, children: 5 },
  steps: {
    develop: { kind: "agent", role: "developer", maxAttempts: 3, next: ["review1", "review2"] },
    review1: { kind: "agent", role: "r1", maxAttempts: 3, next: "assess" },
    review2: { kind: "agent", role: "r2", maxAttempts: 3, next: "assess" },
    assess: {
      kind: "command",
      command: ["node", "assess.js"],
      after: ["review1", "review2"],
      maxAttempts: 3,
      on: { revise: "develop" },
    },
  },
});
function hub(flow: any = definition(), templates: Record<string, unknown> = {}) {
  let view = empty();
  let now = 1000;
  const facts: any[] = [];
  const config: any = {
    timezone: "UTC",
    askFirst: [],
    sources: { app: { name: "输入" } },
    channels: {},
    elsewhere: [],
    agents: { developer: agent, reviewer: { ...agent, access: "read" } },
    workflows: { main: flow, ...templates },
    rules: [
      {
        name: "work",
        when: { source: "app", types: ["new"] },
        to: "developer",
        cwd: "/tmp/work/{item}",
        workflow: "main",
        group: "work",
        tell: "needed",
        parallel: 5,
      },
    ],
  };
  const act = (type: string, ...args: unknown[]) => {
    const result = decide(view, { type, args }, now++, env);
    facts.push(...result.facts);
    view = evolve(view, result.facts);
    return result.value;
  };
  act("rules", config);
  act("ingest", "app", { id: "goal", type: "new", subject: "goal" });
  const job = act("claimNext", "local", "claim");
  return {
    act,
    job,
    config,
    facts,
    get view() {
      return view;
    },
    advance: (body = {}) => act("workflowAdvance", job.run, job.token, body),
  };
}
test("workflow admissions survive replay and join both reviews before a bounded repair", () => {
  const h = hub();
  try {
    assert.ok(h.job.workflow);
    const first = h.advance({ capacity: 2 }).executions;
    assert.equal(first.length, 1);
    assert.equal(first[0].step, "develop");
    assert.equal(h.advance({ capacity: 2 }).executions[0].id, first[0].id);
    h.advance({ started: [{ execution: first[0].id, session: "developer-thread" }], capacity: 0 });
    const reviews = h.advance({
      completed: [{ execution: first[0].id, outcome: "done", session: "developer-thread" }],
      capacity: 2,
    }).executions;
    assert.deepEqual(
      reviews.map((x: any) => x.step),
      ["review1", "review2"],
    );
    const one = {
      execution: reviews[0].id,
      outcome: "done",
      decision: "revise",
      session: "reviewer-one",
      usage: { input: 3 },
    };
    assert.equal(h.advance({ completed: [one], capacity: 2 }).executions.length, 1);
    const join = h.advance({
      completed: [one, { execution: reviews[1].id, outcome: "done", decision: "pass", session: "reviewer-two" }],
      capacity: 2,
    }).executions;
    assert.equal(join[0].step, "assess");
    const repair = h.advance({
      completed: [{ execution: join[0].id, outcome: "done", decision: "revise" }],
      capacity: 2,
    }).executions;
    assert.equal(repair[0].session, "developer-thread");
    assert.equal(repair[0].attempt, 2);
    const root = rows(h.view, "workflows" as any)[0];
    assert.equal(root.usage.turns, 4);
    assert.equal(root.usage.tokens.input, 3);
    assert.equal(JSON.parse(h.view.get("runs", h.job.run)!.usage).input, 3);
    const replay = evolve(empty(), h.facts);
    assert.deepEqual(snapshot(replay), snapshot(h.view));
    replay.close();
  } finally {
    h.view.close();
  }
});
test("frozen definitions and root budget cannot be changed by config reload or result replay", () => {
  const flow = definition();
  flow.budget.turns = 1;
  const h = hub(flow);
  try {
    const started = h.advance().executions[0];
    const changed = structuredClone(h.config);
    changed.workflows.main.budget.turns = 100;
    changed.workflows.main.steps.develop.next = [];
    h.act("rules", changed);
    const result = h.advance({ completed: [{ execution: started.id, outcome: "done" }], capacity: 2 });
    assert.equal(result.state, "blocked");
    assert.equal(result.release, true);
    assert.equal(rows(h.view, "workflow_steps" as any).length, 1);
    assert.equal(h.advance({ completed: [{ execution: started.id, outcome: "done" }] }).release, true);
  } finally {
    h.view.close();
  }
});
test("human waiting releases the run and consumes only the answer for its execution", () => {
  const flow = definition();
  flow.steps.develop.next = [];
  const h = hub(flow);
  try {
    const step = h.advance().executions[0];
    const wait = h.advance({
      completed: [
        {
          execution: step.id,
          outcome: "waiting",
          session: "same",
          ask: [{ title: "选择", text: "继续哪一个？", options: ["一", "二"] }],
        },
      ],
    });
    assert.equal(wait.release, true);
    assert.equal(wait.state, "waiting");
    const card = rows(h.view, "cards")[0];
    h.act("answer", card.id, { choice: 0, by: "owner" });
    const job = h.act("claimNext", "local", "answer");
    assert.equal(job.run, h.job.run);
    const resumed = h.act("workflowAdvance", job.run, job.token, {});
    assert.equal(resumed.executions[0].session, "same");
    assert.equal(resumed.executions[0].attempt, 2);
    assert.equal(resumed.executions[0].input.answers[0].choice, 0);
  } finally {
    h.view.close();
  }
});
test("children respect dependencies and release the parent until its original worker can integrate", () => {
  const flow: any = {
    ...definition(),
    start: "split",
    steps: {
      split: {
        kind: "workflow",
        children: [
          { id: "a", template: "child" },
          { id: "b", template: "child", after: ["a"] },
        ],
        maxAttempts: 1,
        next: "integrate",
      },
      integrate: { kind: "agent", role: "developer", maxAttempts: 1 },
    },
  };
  const h = hub(flow);
  try {
    // Root definitions are frozen when the event enters, so configure the child in that recorded snapshot fixture.
    const config = structuredClone(h.config);
    config.workflows.child = {
      ...definition(),
      cwd: "/tmp/child/{item}",
      start: "write",
      steps: { write: { kind: "agent", role: "developer", maxAttempts: 1 } },
    };
    h.act("rules", config);
    h.act("ingest", "app", { id: "child-goal", type: "new", subject: "child-goal" });
    const parent = h.act("claimNext", "local", "parent-two");
    const waiting = h.act("workflowAdvance", parent.run, parent.token, {});
    assert.equal(waiting.release, true);
    const a = h.act("claimNext", "local", "child-a");
    assert.equal(h.act("claimNext", "local", "blocked-b"), null);
    const aStep = h.act("workflowAdvance", a.run, a.token, {}).executions[0];
    h.act("workflowAdvance", a.run, a.token, { completed: [{ execution: aStep.id, outcome: "done" }] });
    const b = h.act("claimNext", "local", "child-b");
    const bStep = h.act("workflowAdvance", b.run, b.token, {}).executions[0];
    h.act("workflowAdvance", b.run, b.token, { completed: [{ execution: bStep.id, outcome: "done" }] });
    const resumed = h.act("claimNext", "local", "integrate");
    assert.equal(resumed.run, parent.run);
    assert.equal(h.act("workflowAdvance", resumed.run, resumed.token, {}).executions[0].step, "integrate");
  } finally {
    h.view.close();
  }
});
test("pausing one workflow isolates admission and cancellation waits for unknown activity", () => {
  const h = hub();
  try {
    const execution = h.advance().executions[0];
    h.act("workflowControl", h.job.workflow.item, "pause", "owner", {});
    const stopping = h.advance({ blocked: [{ execution: execution.id, summary: "Turn 状态未确认" }] });
    assert.equal(stopping.release, false);
    h.act("workflowControl", h.job.workflow.item, "cancel", "owner", {});
    const cancel = h.advance({ capacity: 2 });
    assert.equal(cancel.cancel, true);
    assert.equal(cancel.state, "cancelling");
    assert.equal(cancel.executions.length, 1);
    const ended = h.advance({ completed: [{ execution: execution.id, outcome: "cancelled" }] });
    assert.equal(ended.state, "cancelled");
    assert.equal(ended.release, true);
  } finally {
    h.view.close();
  }
});
test("an unknown review decision cannot take a successful default edge", () => {
  const flow: any = {
    ...definition(),
    start: "review",
    steps: {
      review: { kind: "agent", role: "r1", maxAttempts: 1, on: { pass: "publish", revise: "fix" }, next: "publish" },
      publish: { kind: "command", command: ["node", "publish.js"], maxAttempts: 1 },
      fix: { kind: "agent", role: "developer", maxAttempts: 1 },
    },
  };
  const h = hub(flow);
  try {
    const execution = h.advance().executions[0];
    const result = h.advance({ completed: [{ execution: execution.id, outcome: "done", decision: "unknown" }] });
    assert.equal(result.state, "blocked");
    assert.equal(result.executions.length, 0);
  } finally {
    h.view.close();
  }
});
test("invalid plans are recorded once and follow the configured bounded replan edge", () => {
  const flow: any = {
    ...definition(),
    start: "plan",
    steps: {
      plan: { kind: "agent", role: "developer", maxAttempts: 2, next: "split" },
      split: { kind: "workflow", planFrom: "plan", templates: ["main"], maxAttempts: 2, on: { failed: "plan" } },
    },
  };
  const h = hub(flow);
  try {
    const planning = h.advance().executions[0];
    const result = h.advance({
      completed: [
        {
          execution: planning.id,
          outcome: "done",
          session: "planner",
          output: { children: [{ id: "bad", template: "not-allowed", cwd: "/elsewhere" }] },
        },
      ],
    });
    const next = result.executions[0] ?? h.advance().executions[0];
    assert.equal(next.step, "plan");
    assert.equal(next.session, "planner");
    assert.equal(rows(h.view, "workflow_steps" as any).find((step) => step.step === "split")!.state, "failed");
    assert.equal(rows(h.view, "workflows" as any).length, 1);
  } finally {
    h.view.close();
  }
});
test("required review decisions cannot disappear into an ordinary done result", () => {
  const flow: any = {
    ...definition(),
    start: "review",
    steps: {
      review: { kind: "agent", role: "r1", maxAttempts: 1, on: { pass: "publish" } },
      publish: { kind: "command", command: ["node", "publish.js"], maxAttempts: 1 },
    },
  };
  const h = hub(flow);
  try {
    const execution = h.advance().executions[0];
    assert.equal(h.advance({ completed: [{ execution: execution.id, outcome: "done" }] }).state, "blocked");
  } finally {
    h.view.close();
  }
});
test("a queued workflow still obeys an existing rule pause", () => {
  const h = hub();
  try {
    h.act("ingest", "app", { id: "second", type: "new", subject: "second" });
    h.act("pauseRule", "work", "owner", {});
    assert.equal(h.act("claimNext", "local", "paused"), null);
  } finally {
    h.view.close();
  }
});
test("cancelling a waiting child does not retire its parent's still-running execution", () => {
  const child: any = {
    ...definition(),
    cwd: "/tmp/child/{item}",
    start: "work",
    steps: { work: { kind: "agent", role: "developer", maxAttempts: 1 } },
  };
  const flow: any = {
    ...definition(),
    start: ["develop", "split"],
    steps: {
      develop: { kind: "agent", role: "developer", maxAttempts: 1 },
      split: { kind: "workflow", template: "child", maxAttempts: 1 },
    },
  };
  const h = hub(flow, { child });
  try {
    const execution = h.advance({ capacity: 2 }).executions[0];
    h.act("workflowControl", h.job.workflow.item, "cancel", "owner", {});
    assert.equal(h.view.get("workflows" as any, h.job.workflow.item)!.state, "cancelling");
    const live = h.advance({ capacity: 0 });
    assert.equal(live.release, false);
    assert.equal(live.executions[0].id, execution.id);
    assert.equal(h.advance({ completed: [{ execution: execution.id, outcome: "cancelled" }] }).state, "cancelled");
  } finally {
    h.view.close();
  }
});
test("a failed child propagates through reverse-ordered dependencies and retires the waiting parent run", () => {
  const child: any = {
    ...definition(),
    cwd: "/tmp/child/{item}",
    start: "work",
    steps: { work: { kind: "agent", role: "developer", maxAttempts: 1 } },
  };
  const flow: any = {
    ...definition(),
    start: "split",
    steps: {
      split: {
        kind: "workflow",
        maxAttempts: 1,
        children: [
          { id: "c", template: "child", after: ["b"] },
          { id: "b", template: "child", after: ["a"] },
          { id: "a", template: "child" },
        ],
      },
    },
  };
  const h = hub(flow, { child });
  try {
    h.advance();
    const first = h.act("claimNext", "local", "a");
    const execution = h.act("workflowAdvance", first.run, first.token, {}).executions[0];
    h.act("workflowAdvance", first.run, first.token, {
      completed: [{ execution: execution.id, outcome: "failed", summary: "失败" }],
    });
    assert.ok(rows(h.view, "workflows" as any).every((item) => item.state === "failed"));
    assert.equal(h.view.get("runs", h.job.run)!.state, "failed");
  } finally {
    h.view.close();
  }
});
test("pause and resume do not turn an uncertain finished command into completed work", () => {
  const h = hub({
    ...definition(),
    start: "publish",
    steps: { publish: { kind: "command", command: ["node", "publish.js"], maxAttempts: 1 } },
  });
  try {
    const execution = h.advance().executions[0];
    h.advance({ completed: [{ execution: execution.id, outcome: "blocked", summary: "发布结果未确认" }] });
    h.act("workflowControl", h.job.workflow.item, "pause", "owner", {});
    h.act("workflowControl", h.job.workflow.item, "pause", "owner", {});
    h.act("workflowControl", h.job.workflow.item, "resume", "owner", {});
    assert.equal(h.view.get("workflows" as any, h.job.workflow.item)!.state, "blocked");
    assert.equal(h.view.get("workflows" as any, h.job.workflow.item)!.reason, "发布结果未确认");
    assert.equal(h.act("claimNext", "local", "should-not-retry"), null);
  } finally {
    h.view.close();
  }
});
test("a failed parallel branch remains controllable until its other branch has stopped", () => {
  const flow: any = {
    ...definition(),
    start: ["review1", "review2"],
    steps: {
      review1: { kind: "agent", role: "r1", maxAttempts: 1 },
      review2: { kind: "agent", role: "r2", maxAttempts: 1 },
    },
  };
  const h = hub(flow);
  try {
    const execution = h.advance({ capacity: 2 }).executions;
    const stopping = h.advance({
      completed: [{ execution: execution[0].id, outcome: "failed", summary: "审查无法完成" }],
      capacity: 2,
    });
    assert.equal(stopping.state, "cancelling");
    assert.equal(stopping.cancel, true);
    assert.equal(stopping.release, false);
    const failed = h.advance({ completed: [{ execution: execution[1].id, outcome: "cancelled" }] });
    assert.equal(failed.state, "failed");
    assert.equal(failed.release, true);
  } finally {
    h.view.close();
  }
});
test("an answer is consumed by the resumed attempt and cannot authorize a later loop", () => {
  const flow: any = {
    ...definition(),
    start: "approve",
    steps: {
      approve: { kind: "agent", role: "developer", maxAttempts: 3, next: "cycle" },
      cycle: { kind: "command", command: ["node", "cycle.js"], maxAttempts: 2, next: "approve" },
    },
  };
  const h = hub(flow);
  try {
    const first = h.advance().executions[0];
    h.advance({
      completed: [
        {
          execution: first.id,
          outcome: "waiting",
          ask: [{ title: "操作 A", text: "允许执行 A？", options: ["允许", "不允许"] }],
        },
      ],
    });
    h.act("answer", rows(h.view, "cards")[0].id, { choice: 0 });
    const job = h.act("claimNext", "local", "answered");
    const advance = (body = {}) => h.act("workflowAdvance", job.run, job.token, body);
    const resumed = advance().executions[0];
    assert.equal(resumed.input.answers.length, 1);
    const cycle = advance({ completed: [{ execution: resumed.id, outcome: "done" }] }).executions[0];
    const next = advance({ completed: [{ execution: cycle.id, outcome: "done" }] }).executions[0];
    assert.equal(next.attempt, 3);
    assert.deepEqual(next.input.answers, []);
  } finally {
    h.view.close();
  }
});
