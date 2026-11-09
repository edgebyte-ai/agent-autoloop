// Failure modes: a lost push or PR response creates another PR, recovery repeats an external write, or an existing
// branch/PR for a different commit is overwritten. Native Git must publish a pinned commit without shell interpolation.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import {
  createPublishIO,
  publish,
  publishConfig,
  type PublishIO,
  type PublishRequest,
} from "../examples/workflows/publish.ts";

const sha = "a".repeat(40);
const request: PublishRequest = {
  repo: "example/project",
  remote: "origin",
  branch: "codex/work-12",
  base: "main",
  title: "完成工作项 12",
  body: "本机测试已通过。",
  commit: sha,
};
function fake() {
  let remote: string | null = null;
  let pulls: any[] = [];
  let pushes = 0;
  let creations = 0;
  const io: PublishIO = {
    remoteHead: () => remote,
    push: () => {
      pushes++;
      remote = sha;
      throw new Error("push response lost");
    },
    pulls: async () => pulls,
    create: async () => {
      creations++;
      pulls = [
        {
          number: 7,
          html_url: "https://github.com/example/project/pull/7",
          state: "open",
          head: { sha, ref: request.branch },
          base: { ref: "main" },
        },
      ];
      throw new Error("create response lost");
    },
  };
  return {
    io,
    counts: () => ({ pushes, creations }),
    setRemote: (value: string) => {
      remote = value;
    },
    setPulls: (value: any[]) => {
      pulls = value;
    },
  };
}

test("lost mutation responses are read back and a replay makes no external write", async () => {
  const it = fake();
  const first = await publish(request, it.io);
  assert.equal(first?.url, "https://github.com/example/project/pull/7");
  assert.deepEqual(await publish(request, it.io), first);
  assert.deepEqual(it.counts(), { pushes: 1, creations: 1 });
});

test("reconciliation only reports observed completion and never pushes or creates", async () => {
  const it = fake();
  assert.equal(await publish(request, it.io, true), null);
  it.setRemote(sha);
  assert.equal(await publish(request, it.io, true), null);
  assert.deepEqual(it.counts(), { pushes: 0, creations: 0 });
});

test("another commit or a closed unmerged PR blocks publication", async () => {
  const it = fake();
  it.setRemote("b".repeat(40));
  await assert.rejects(publish(request, it.io), /分支/);
  it.setRemote(sha);
  it.setPulls([
    { number: 8, state: "closed", merged_at: null, head: { sha, ref: request.branch }, base: { ref: "main" } },
  ]);
  await assert.rejects(publish(request, it.io), /关闭/);
  assert.deepEqual(it.counts(), { pushes: 0, creations: 0 });
});

test("only a worker-supplied numeric item can fill a branch placeholder", () => {
  const config = {
    repo: request.repo,
    remote: "origin",
    branch: "codex/work-{item}",
    base: "main",
    title: request.title,
    bodyFile: "body.md",
  };
  assert.equal(publishConfig(config, 12).branch, "codex/work-12");
  assert.throws(() => publishConfig(config), /工作项/);
  assert.throws(() => publishConfig({ ...config, branch: "--all" }, 12), /分支/);
});

const temporary = process.platform === "win32" ? join(homedir(), "AppData", "Local", "Temp") : tmpdir();
const folder = mkdtempSync(join(temporary, "agent-autoloop-publish-"));
after(() => rmSync(folder, { recursive: true, force: true }));
test("native Git publishes the pinned commit into a local remote with spaces and Chinese paths", async () => {
  const cwd = join(folder, "工作 目录");
  const remote = join(folder, "远端 仓库.git");
  mkdirSync(cwd);
  const git = (where: string, ...args: string[]) =>
    execFileSync("git", args, { cwd: where, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(folder, "init", "--bare", remote);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Workflow Test");
  git(cwd, "config", "user.email", "workflow@example.invalid");
  writeFileSync(join(cwd, "result.txt"), "完成\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "test");
  git(cwd, "remote", "add", "origin", join(folder, "fetch-only.git"));
  git(cwd, "remote", "set-url", "--push", "origin", remote);
  const commit = git(cwd, "rev-parse", "HEAD");
  const io = createPublishIO(cwd, { ...request, commit });
  assert.equal(io.remoteHead(), null);
  io.push(commit);
  assert.equal(io.remoteHead(), commit);
});

test("the command accepts frozen inline configuration and records no publication for a dirty workspace", () => {
  const cwd = join(folder, "工作 目录");
  writeFileSync(join(cwd, "unfinished.txt"), "未提交\n");
  const state = join(folder, "publication.json");
  const result = spawnSync(
    process.execPath,
    [resolve("examples/workflows/publish.ts"), JSON.stringify({ ...request, bodyFile: "result.txt" }), state],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /工作区还有未提交改动/);
  assert.equal(existsSync(state), false);
});
