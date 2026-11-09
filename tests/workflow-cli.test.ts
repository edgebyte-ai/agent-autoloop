// Failure modes: workflow controls use a source key, a cancellation request is reported as completed,
// child progress and role sessions disappear from the display, or a malformed ID reaches the hub.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("workflow-cli");
const calls: { path: string; key: string; body: unknown }[] = [];
const root = {
  id: 7,
  root: 7,
  parent: null,
  run: 42,
  definition: "drdr",
  worker: "windows",
  cwd: "C:\\work",
  state: "running",
  pending: ["review"],
  sessions: { developer: "thread-dev", reviewer: "thread-review" },
  progress_at: "2026-11-08T19:00:00Z",
  reason: "等待审查",
  budget: { turns: 10 },
  usage: { turns: 3 },
};
const detail = {
  seq: 9,
  root,
  item: root,
  items: [root, { ...root, id: 8, parent: 7, state: "done", pending: [] }],
  executions: [{ id: 4, item: 7, step: "review", role: "reviewer", attempt: 2, state: "done", output: "需要补充测试" }],
};
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  calls.push({ path: req.url!, key: req.headers.authorization!, body: raw ? JSON.parse(raw) : null });
  const response =
    req.url === "/v1/workflows"
      ? { seq: 9, workflows: [root] }
      : req.url === "/v1/workflows/7"
        ? detail
        : req.url?.endsWith("/run")
          ? { run: 42 }
          : { changed: true, item: { ...root, state: "running", cancel: true } };
  res.end(JSON.stringify(response));
});
before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      owner: "owner-key",
      source: { name: "local", key: "source-key" },
    }),
  );
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const cli = (...args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "bin/agent-autoloop.ts", "workflow", ...args],
      { cwd: join(import.meta.dirname, ".."), env: process.env },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    );
  });

test("workflow list and show expose the root, children, progress, sessions and execution results", async () => {
  const listed = await cli("list");
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /#7.*drdr/);
  const shown = await cli("show", "7");
  assert.equal(shown.code, 0, shown.stderr);
  for (const text of ["#8", "thread-dev", "thread-review", "等待审查", "需要补充测试", "2026-11-08T19:00:00Z"])
    assert.ok(shown.stdout.includes(text), text);
  const raw = await cli("show", "7", "--json");
  assert.deepEqual(JSON.parse(raw.stdout), detail);
  assert.ok(calls.every((call) => call.key === "Bearer owner-key"));
});

test("workflow controls reach the specified item and cancellation remains a request", async () => {
  for (const action of ["pause", "resume", "cancel"]) {
    const done = await cli(action, "8", "--reason", "核对产物");
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual(calls.at(-1), {
      path: `/v1/workflows/8/${action}`,
      key: "Bearer owner-key",
      body: { reason: "核对产物" },
    });
    if (action === "cancel") {
      assert.match(done.stdout, /取消请求/);
      assert.doesNotMatch(done.stdout, /已取消|取消完成/);
    }
  }
  const started = await cli("start", "文档起草", "--subject", "说明书", "--reason", "新目标");
  assert.equal(started.code, 0, started.stderr);
  assert.deepEqual(calls.at(-1), {
    path: `/v1/rules/${encodeURIComponent("文档起草")}/run`,
    key: "Bearer owner-key",
    body: { subject: "说明书", reason: "新目标" },
  });
});

test("workflow malformed IDs and action flags do not issue requests", async () => {
  const count = calls.length;
  for (const args of [
    ["show", "0"],
    ["cancel", "7e0"],
    ["pause", "7", "--subject", "wrong"],
  ]) {
    const result = await cli(...args);
    assert.equal(result.code, 1, result.stdout);
  }
  assert.equal(calls.length, count);
});
