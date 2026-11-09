// Failure modes: a workflow changes authority through an unknown role, command or template; a misspelled edge or
// unbounded attempt count reaches execution; introducing workflows breaks ordinary rules without that option.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRules } from "../protocol/rules.ts";
import { checkWorkflowChildren, parseWorkflowAdvance } from "../protocol/workflow.ts";
import { checkSchema } from "../protocol/schema.ts";

const config = (): any => ({
  sources: { manual: { name: "手工" } },
  agents: {
    writer: { name: "写作", worker: "local", use: "command", command: ["node", "write.mjs"] },
    reviewer: { name: "校对", worker: "local", use: "command", command: ["node", "review.mjs"] },
  },
  rules: [
    {
      name: "写文档",
      when: { source: "manual", types: ["document"] },
      to: "writer",
      cwd: "C:\\文档 工作",
      workflow: "document",
    },
  ],
  workflows: {
    document: {
      start: "draft",
      roles: { writer: { agent: "writer" }, reviewer: { agent: "reviewer" } },
      budget: { turns: 8, activeMs: 600_000, concurrency: 2, depth: 2, children: 3 },
      steps: {
        draft: { kind: "agent", role: "writer", prompt: "写一份说明", next: "review", maxAttempts: 3 },
        review: {
          kind: "agent",
          role: "reviewer",
          prompt: "检查说明",
          on: { revise: "draft", pass: "export" },
          maxAttempts: 3,
        },
        export: { kind: "command", command: ["node", "export.mjs"], maxAttempts: 1 },
      },
    },
  },
});
const parse = (value: unknown) => parseRules(JSON.stringify(value), Date.parse("2026-11-08T00:00:00Z"), "UTC");

test("explicit workflows accept bounded role loops and non-repository command steps", () => {
  const parsed = parse(config());
  assert.equal(parsed.rules[0].workflow, "document");
  assert.equal(parsed.workflows!.document.steps.review.maxAttempts, 3);
});

test("ordinary configurations keep working without workflows", () => {
  const value = config();
  delete value.workflows;
  delete value.rules[0].workflow;
  const parsed = parse(value);
  assert.equal(parsed.workflows, undefined);
  assert.equal(parsed.rules[0].cwd, "C:\\文档 工作");
});

test("workflow references and finite budgets are validated before any work is admitted", () => {
  const invalid: [(value: any) => void, RegExp][] = [
    [(v) => (v.rules[0].workflow = "missing"), /workflow.*missing/],
    [(v) => (v.workflows.document.steps.draft.role = "unknown"), /role.*unknown/],
    [(v) => (v.workflows.document.roles.writer.agent = "unknown"), /agent.*unknown/],
    [(v) => (v.workflows.document.steps.draft.next = "unknown"), /next.*unknown/],
    [(v) => (v.workflows.document.steps.review.on.revise = "unknown"), /on.*unknown/],
    [(v) => (v.workflows.document.steps.draft.maxAttempts = 0), /maxAttempts/],
    [(v) => (v.workflows.document.budget.turns = 0), /turns/],
    [(v) => (v.workflows.document.steps.export.command = "node export.mjs"), /command/],
    [(v) => (v.workflows.document.steps.draft.cwd = "C:\\elsewhere"), /不认识.*cwd/],
    [(v) => (v.agents.reviewer.worker = "remote"), /同一.*worker/],
    [
      (v) => (
        (v.workflows.document.steps.review.after = ["export"]),
        (v.workflows.document.steps.export.after = ["review"])
      ),
      /依赖.*循环/,
    ],
  ];
  for (const [change, expected] of invalid) {
    const value = config();
    change(value);
    assert.throws(() => parse(value), expected);
  }
});

test("child plans only name allowed templates and acyclic sibling dependencies", () => {
  const children = [
    { id: "draft", template: "single", after: [], input: { filename: "notes.txt" } },
    { id: "export", template: "single", after: ["draft"] },
  ];
  assert.deepEqual(checkWorkflowChildren(children, ["single"]), []);
  assert.ok(checkWorkflowChildren([{ ...children[0], cwd: "C:\\private" }], ["single"]).length);
  assert.ok(checkWorkflowChildren([{ ...children[0], command: ["delete", "all"] }], ["single"]).length);
  assert.ok(checkWorkflowChildren(children, ["other"]).length);
  assert.ok(checkWorkflowChildren([{ ...children[0], after: ["export"] }, children[1]], ["single"]).length);
});

test("child templates reserve a distinct working directory for each work item", () => {
  const value = config();
  value.workflows.child = { ...value.workflows.document, cwd: "C:\\work\\shared" };
  value.workflows.document.steps.export = { kind: "workflow", template: "child" };
  assert.throws(() => parse(value), /cwd.*\{item\}/);
  value.workflows.child.cwd = "C:\\work\\child-{item}";
  assert.equal(parse(value).workflows!.child.cwd, "C:\\work\\child-{item}");
});

test("published workflow shapes reject authority fields in child plans and keep ordinary jobs valid", () => {
  const definition = config().workflows.document;
  assert.deepEqual(checkSchema("workflow-definition", definition), []);
  assert.ok(checkSchema("workflow-step", { kind: "command", command: "node export.mjs" }).length);
  assert.ok(checkSchema("workflow-child", { id: "part", template: "single", cwd: "C:\\private" }).length);
  const job = {
    run: 1,
    token: "opaque",
    attempt: 1,
    rule: { name: "文档", cwd: "C:\\notes" },
    agent: { id: "writer", name: "写作", use: "command", access: "edit", threadIdleMinutes: 120 },
    session: null,
    askFirst: [],
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
  assert.deepEqual(checkSchema("job", job), []);
  assert.deepEqual(checkSchema("job", { ...job, workflow: { item: 1, root: 1 } }), []);
  assert.ok(checkSchema("job", { ...job, workflow: { item: 1, root: 1, command: ["run"] } }).length);
});

test("execution reports keep unknown usage unknown and reject forged authority or malformed receipts", () => {
  const result = { execution: 1, outcome: "done", output: { text: "写好了" }, session: "thread-1", activeMs: 12 };
  assert.deepEqual(parseWorkflowAdvance({ completed: [result], capacity: 1 }), { completed: [result], capacity: 1 });
  assert.deepEqual(checkSchema("workflow-advance", { completed: [result], capacity: 1 }), []);
  assert.equal(parseWorkflowAdvance({ completed: [result] }).completed![0].usage, undefined);
  const unknown = { blocked: [{ execution: 1, summary: "还没确认原执行是否已退出" }], capacity: 0 };
  assert.deepEqual(parseWorkflowAdvance(unknown), unknown);
  assert.deepEqual(checkSchema("workflow-advance", unknown), []);
  assert.deepEqual(
    parseWorkflowAdvance({ started: [{ execution: 1, session: "thread-1", turn: "turn-1" }], capacity: 0 }),
    {
      started: [{ execution: 1, session: "thread-1", turn: "turn-1" }],
      capacity: 0,
    },
  );
  for (const invalid of [
    { completed: [{ ...result, cwd: "C:\\private" }] },
    { completed: [{ ...result, outcome: "complete-everything" }] },
    { completed: [{ ...result, usage: { input: -1 } }] },
    { completed: [{ ...result, ask: [{ title: "继续？", text: "确认", options: ["是"] }] }] },
    { started: [{ execution: 1, session: "thread-1", access: "full" }] },
  ]) {
    assert.throws(() => parseWorkflowAdvance(invalid));
    assert.ok(checkSchema("workflow-advance", invalid).length);
  }
});
