// Failure modes: importing a test runner writes to GitHub; an existing repository or unrelated files are removed;
// native Windows cleanup declares success while worker execution is still active.
// A closed test PR must not keep its own labels alive, and another PR's use must preserve a shared label.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  repositoryTarget,
  writeFixture,
  removeFixture,
  stopWorker,
  removeTestLabels,
} from "../scripts/delivery-e2e.ts";

test("cleanup removes the test PR's labels while preserving labels used by other PRs", async () => {
  const attached = new Map([
    [132, ["deliver", "deliver-attended", "existing"]],
    [10, ["deliver-attended"]],
  ]);
  const global = new Set(["deliver", "deliver-attended", "existing"]);
  const writes: string[] = [];
  const api = async (path: string, _body?: unknown, method = "GET"): Promise<any> => {
    const issue = /^issues\/(\d+)$/.exec(path);
    if (issue) return { labels: attached.get(Number(issue[1]))!.map((name) => ({ name })) };
    const remove = /^issues\/(\d+)\/labels\/(.+)$/.exec(path);
    if (remove && method === "DELETE") {
      writes.push(path);
      attached.set(
        Number(remove[1]),
        attached.get(Number(remove[1]))!.filter((name) => name !== remove[2]),
      );
      return [];
    }
    if (path.startsWith("issues?")) {
      const name = new URLSearchParams(path.split("?")[1]).get("labels");
      return [...attached].filter(([, labels]) => labels.includes(name!)).map(([number]) => ({ number }));
    }
    if (path.startsWith("labels/") && method === "DELETE") {
      writes.push(path);
      global.delete(path.slice(7));
      return;
    }
    assert.fail(`unexpected ${method} ${path}`);
  };
  assert.deepEqual(await removeTestLabels(api, [132], ["deliver", "deliver-attended"]), ["deliver-attended"]);
  assert.deepEqual(attached.get(132), ["existing"]);
  assert.deepEqual(attached.get(10), ["deliver-attended"]);
  assert.deepEqual([...global], ["deliver-attended", "existing"]);
  assert.deepEqual(writes, ["issues/132/labels/deliver", "issues/132/labels/deliver-attended", "labels/deliver"]);
});

test("the explicit existing repository can be named by SSH URL or owner/name", () => {
  const expected = { repo: "edgebyte-ai/agent_work_test", remote: "git@github.com:edgebyte-ai/agent_work_test.git" };
  assert.deepEqual(repositoryTarget("git@github.com:edgebyte-ai/agent_work_test.git"), expected);
  assert.deepEqual(repositoryTarget("edgebyte-ai/agent_work_test"), expected);
  assert.throws(() => repositoryTarget("git@other.example:edgebyte-ai/agent_work_test.git"));
});

test("fixture setup refuses collisions and cleanup preserves unrelated repository files", () => {
  const base = process.platform === "win32" ? join(homedir(), "AppData", "Local", "Temp") : tmpdir();
  const work = mkdtempSync(join(base, "autoloop-delivery-fixture-"));
  try {
    execFileSync("git", ["init", "-q", work]);
    writeFileSync(join(work, "README.md"), "existing\n");
    assert.throws(() => writeFixture(work, { "README.md": "replacement", "new.txt": "must not write" }), /存在/);
    assert.equal(readFileSync(join(work, "README.md"), "utf8"), "existing\n");
    assert.equal(existsSync(join(work, "new.txt")), false);
    const files = { "ops/delivery.json": "test settings", ".agent-autoloop-e2e/test-run/fixture.txt": "fixture" };
    writeFixture(work, files);
    execFileSync("git", ["add", "."], { cwd: work });
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "seed"], {
      cwd: work,
    });
    removeFixture(work, "test-run", files);
    assert.equal(readFileSync(join(work, "README.md"), "utf8"), "existing\n");
    assert.equal(existsSync(join(work, "ops/delivery.json")), false);
    assert.equal(existsSync(join(work, ".agent-autoloop-e2e/test-run/fixture.txt")), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("worker cleanup waits for cancellation confirmation before closing its resident connection", async () => {
  let held = [{ run: 7 }];
  const actions: string[] = [];
  await stopWorker(
    {
      entries: () => held,
      tick: async () => {
        actions.push("confirmed");
        held = [];
      },
      close: async () => {
        actions.push("closed");
      },
    },
    async (entry) => {
      assert.equal(entry.run, 7);
      actions.push("requested");
    },
  );
  assert.deepEqual(actions, ["requested", "confirmed", "closed"]);
});
