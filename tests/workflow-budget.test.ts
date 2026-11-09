// Failure modes: parallel steps each spend the whole remaining time budget; result replay reserves or charges twice;
// stopping overhead is hidden, or a retry gets fresh time after the root budget was spent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve } from "../kernel/evolve.ts";

function hub() {
  let view = empty();
  let now = 1000;
  const act = (type: string, ...args: unknown[]) => {
    const decision = decide(view, { type, args }, now++, { secret: "budget", publicUrl: "https://hub.test" });
    view = evolve(view, decision.facts);
    return decision.value;
  };
  act("rules", {
    timezone: "UTC",
    askFirst: [],
    sources: { app: { name: "资料" } },
    channels: {},
    elsewhere: [],
    agents: { a: { name: "执行者", worker: "local", use: "command", command: ["node", "step.js"], access: "edit" } },
    workflows: {
      bounded: {
        start: ["one", "two"],
        roles: {},
        to: "a",
        budget: { turns: 3, activeMs: 1000, concurrency: 2, depth: 0, children: 0 },
        steps: {
          one: { kind: "command", command: ["node", "one.js"], maxAttempts: 2, next: "three", on: { failed: "one" } },
          two: { kind: "command", command: ["node", "two.js"], maxAttempts: 1 },
          three: { kind: "command", command: ["node", "three.js"], maxAttempts: 1 },
        },
      },
    },
    rules: [
      {
        name: "bounded",
        when: { source: "app", types: ["new"] },
        to: "a",
        cwd: "/tmp/bounded",
        workflow: "bounded",
        group: "bounded",
        tell: "needed",
      },
    ],
  });
  act("ingest", "app", { id: "one", type: "new" });
  const job = act("claimNext", "local", "claim");
  return {
    advance: (body: object) => act("workflowAdvance", job.run, job.token, body),
    root: () => view.get("workflows", job.workflow.item)!,
    close: () => view.close(),
  };
}

test("parallel steps share a durable time reservation and return unused time once", () => {
  const h = hub();
  try {
    const first = h.advance({ capacity: 2 }).executions;
    assert.deepEqual(
      first.map((step: any) => step.timeLimitMs),
      [500, 500],
    );
    assert.deepEqual(h.advance({ capacity: 2 }).executions, first);
    const completed = { execution: first[0].id, outcome: "done", activeMs: 100 };
    const next = h.advance({ completed: [completed], capacity: 1 }).executions;
    assert.equal(next.find((step: any) => step.step === "two").timeLimitMs, 500);
    assert.equal(next.find((step: any) => step.step === "three").timeLimitMs, 400);
    assert.equal(h.root().usage.activeMs, 100);
    assert.deepEqual(h.advance({ completed: [completed], capacity: 1 }).executions, next);
    assert.equal(h.root().usage.activeMs, 100);
  } finally {
    h.close();
  }
});

test("actual stop overhead remains charged and cannot finance another retry", () => {
  const h = hub();
  try {
    const first = h.advance({ capacity: 1 }).executions[0];
    assert.equal(first.timeLimitMs, 1000);
    const result = h.advance({ completed: [{ execution: first.id, outcome: "failed", activeMs: 1050 }], capacity: 2 });
    assert.equal(result.state, "blocked");
    assert.deepEqual(result.executions, []);
    assert.equal(h.root().usage.activeMs, 1050);
  } finally {
    h.close();
  }
});
