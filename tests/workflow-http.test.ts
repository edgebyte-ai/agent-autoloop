// Failure modes: workflow state or controls accept a source/worker key; a misspelled control is ignored;
// a run token can advance another work item; workflow facts are absent from the existing event stream or run history.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";

setup("workflow-http");
const hub = await import("./hub.ts");
const { makeHandler } = await import("../host/server.ts");
const runtime = makeHandler("test");
after(runtime.close);
const owner = hub.addKey("owner", "me");
const worker = hub.addKey("worker", "w1");
const source = hub.addKey("source", "app");
let otherRunToken = "";
const call = (path: string, key = owner, body?: unknown) =>
  runtime.handle(
    new Request(`http://local${path}`, {
      headers: { authorization: `Bearer ${key}` },
      ...(body !== undefined && { method: "POST", body: JSON.stringify(body) }),
    }),
  );

test("workflow state and control use the owner's existing door", async () => {
  const response = await call("/v1/workflows");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { seq: hub.getView().seq, workflows: [] });
  for (const key of [worker, source, ""]) {
    for (const path of ["/v1/workflows", "/v1/workflows/1"]) {
      assert.equal((await call(path, key)).status, 401, path);
    }
    for (const action of ["pause", "resume", "cancel"]) {
      assert.equal((await call(`/v1/workflows/1/${action}`, key, {})).status, 401, action);
    }
  }
  assert.equal((await call("/v1/workflows/999")).status, 404);
});

test("workflow control validates its body before dispatch", async () => {
  for (const body of [[], null, { reson: "拼错了" }, { reason: 3 }, { reason: "x".repeat(1001) }]) {
    assert.equal((await call("/v1/workflows/1/pause", owner, body)).status, 400);
  }
});

test("the workflow execution door does not turn a worker or owner key into a run capability", async () => {
  hub.ingest("app", { id: "workflow-token", type: "feedback.new", subject: "token" });
  const job = hub.claimNext("w1", "workflow-token")!;
  assert.ok(job);
  otherRunToken = job.token;
  for (const key of [owner, worker, source, ""]) {
    assert.equal((await call(`/v1/runs/${job.run}/workflow`, key, {})).status, 401);
  }
  assert.equal((await call(`/v1/runs/${job.run}/workflow`, job.token, {})).status, 401);
});

test("the owner sees admitted work, pauses at its boundary, and resumes the unfinished step", async () => {
  const config = structuredClone(hub.rules);
  config.workflows = {
    document: {
      start: "write",
      roles: { writer: { agent: "a1" } },
      budget: { turns: 3, activeMs: 60_000, concurrency: 1, depth: 0, children: 0 },
      steps: {
        write: { kind: "agent", role: "writer", prompt: "写文档。", maxAttempts: 1, next: "export" },
        export: { kind: "command", command: ["node", "export.mjs"], maxAttempts: 1 },
      },
    },
  };
  config.rules.push({
    name: "写文档",
    when: { source: "app", types: ["document.new"] },
    to: "a1",
    cwd: "/tmp/documents/{item}",
    workflow: "document",
    group: "documents",
    tell: "needed",
  });
  hub.execute("rules", [config]);
  const queued = await (await call(`/v1/rules/${encodeURIComponent("写文档")}/run`, owner, {})).json();
  const job = (await (await call("/v1/work?claim=document&wait=0", worker)).json()).job;
  assert.equal(job.run, queued.run);
  const item = job.workflow.item;
  assert.equal((await call(`/v1/runs/${job.run}/workflow`, otherRunToken, {})).status, 401);
  const advance = async (body: unknown, token = job.token) => {
    const response = await call(`/v1/runs/${job.run}/workflow`, token, body);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const admitted = (await advance({ capacity: 1 })).executions[0];
  await advance({ started: [{ execution: admitted.id, session: "writer-thread" }], capacity: 0 });
  const before = hub.getView().seq;
  assert.equal((await call(`/v1/workflows/${item}/pause`, owner, { reason: "检查草稿" })).status, 200);
  const paused = await advance({
    completed: [{ execution: admitted.id, outcome: "done", summary: "草稿已写好", activeMs: 5 }],
    capacity: 1,
  });
  assert.equal(paused.release, true);
  assert.equal(paused.executions.length, 0);
  const shown = await (await call(`/v1/workflows/${item}`)).json();
  assert.equal(shown.item.sessions.writer, "writer-thread");
  assert.equal(shown.executions.length, 1);
  assert.equal(shown.executions[0].state, "done");
  assert.ok(shown.item.pending.includes("export"));
  assert.ok(shown.item.progress_at);
  const stream = await call(`/v1/stream?after=${before}`);
  const reader = stream.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /workflowControl/);
  await reader.cancel();
  assert.equal((await call(`/v1/workflows/${item}/resume`, owner, {})).status, 200);
  const resumed = (await (await call("/v1/work?claim=document-resumed&wait=0", worker)).json()).job;
  assert.equal(resumed.run, job.run);
  const last = (await advance({ capacity: 1 }, resumed.token)).executions[0];
  assert.equal(last.step, "export");
  await advance(
    { completed: [{ execution: last.id, outcome: "done", output: { file: "document.md" } }] },
    resumed.token,
  );
  const finished = await (await call(`/v1/workflows/${item}`)).json();
  assert.equal(finished.root.state, "done");
  assert.equal(finished.executions.length, 2);
  assert.equal(finished.root.usage.turns, 1);
  assert.ok(!JSON.stringify(finished).includes(job.token));
});

test("why includes step admissions and sessions before the work item finishes", async () => {
  await call(`/v1/rules/${encodeURIComponent("写文档")}/run`, owner, {});
  const job = (await (await call("/v1/work?claim=document-history&wait=0", worker)).json()).job;
  const first = await (await call(`/v1/runs/${job.run}/workflow`, job.token, { capacity: 1 })).json();
  const execution = first.executions[0].id;
  await call(`/v1/runs/${job.run}/workflow`, job.token, {
    started: [{ execution, session: "history-thread", turn: "history-turn" }],
    capacity: 0,
  });
  const facts = await (await call(`/v1/runs/${job.run}/why`)).json();
  const changes = facts.flatMap((fact: any) => fact.changes);
  assert.ok(
    changes.some(
      (change: any) =>
        change.table === "workflow_steps" && change.row?.id === execution && change.row.state === "admitted",
    ),
  );
  assert.ok(
    changes.some(
      (change: any) =>
        change.table === "workflow_steps" &&
        change.row?.session === "history-thread" &&
        change.row.turn === "history-turn",
    ),
  );
  assert.ok(
    changes.some((change: any) => change.table === "workflows" && change.row?.sessions.writer === "history-thread"),
  );
});
