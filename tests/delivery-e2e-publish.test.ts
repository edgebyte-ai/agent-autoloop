// Failure modes: the fault fixture replaces real writes with fake success, or hides repeated writes during recovery.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { publish, type PublishIO, type PublishRequest } from "../examples/workflows/publish.ts";
import { checkPublicationScope, loseMutationReplies } from "../scripts/delivery-e2e/publish.ts";

test("real Git scope checking rejects changes and renames outside the authorized fixture before publication", () => {
  const temporary = process.platform === "win32" ? join(homedir(), "AppData", "Local", "Temp") : tmpdir();
  const root = mkdtempSync(join(temporary, "autoloop-e2e-publish-scope-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const commit = () => {
    git("add", "--all");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q");
    writeFileSync(join(root, "README.md"), "unrelated existing file\n");
    const base = commit();
    const remote = "git@github.com:owner/test.git";
    git("remote", "add", "origin", remote);
    const folder = ".agent-autoloop-e2e/test-run";
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, "new.txt"), "test\n");
    const own = commit();
    checkPublicationScope(root, own, { base, folder, remote });
    assert.throws(
      () => checkPublicationScope(root, own, { base, folder, remote: "git@github.com:other/repo.git" }),
      /远端/,
    );
    renameSync(join(root, "README.md"), join(root, folder, "moved.md"));
    assert.throws(() => checkPublicationScope(root, commit(), { base, folder, remote }), /目录之外/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication loses only successful write replies and then reads back the same branch and PR", async () => {
  const request: PublishRequest = {
    repo: "owner/test",
    remote: "origin",
    branch: "codex/e2e/test",
    base: "main",
    title: "测试",
    body: "test",
    commit: "a".repeat(40),
  };
  let head: string | null = null;
  const pulls: any[] = [];
  const writes: string[] = [];
  const lost: string[] = [];
  const real: PublishIO = {
    remoteHead: () => head,
    push: (commit) => {
      writes.push("push");
      head = commit;
    },
    pulls: async () => pulls,
    create: async () => {
      writes.push("create");
      pulls.push({
        number: 1,
        html_url: "https://github.com/owner/test/pull/1",
        state: "open",
        head: { sha: request.commit, ref: request.branch },
        base: { ref: request.base },
      });
    },
  };
  const io = loseMutationReplies(real, (kind) => {
    assert.equal(head, request.commit, "the push actually happened before its reply was dropped");
    if (kind === "create") assert.equal(pulls.length, 1);
    lost.push(kind);
  });
  const result = await publish(request, io);
  assert.equal(result?.number, 1);
  assert.deepEqual(writes, ["push", "create"]);
  assert.deepEqual(lost, writes);
  assert.deepEqual(await publish(request, io), result);
  assert.deepEqual(await publish(request, io, true), result);
  assert.deepEqual(writes, ["push", "create"]);
});
