// Real writes still use the production publisher; only their successful replies are deliberately discarded.
import { appendFileSync } from "node:fs";
import { createPublishIO, runPublication, type PublishIO } from "../../examples/workflows/publish.ts";
import { git } from "../../plugins/delivery/project.ts";

export function checkPublicationScope(
  cwd: string,
  commit: string,
  scope: { base: string; folder: string; remote: string },
) {
  if (!/^[a-f0-9]{40}$/.test(scope.base) || !/^\.agent-autoloop-e2e\/[a-z0-9-]+$/.test(scope.folder))
    throw new Error("验收发布缺少可信基准提交或测试目录");
  if (git(cwd, "merge-base", scope.base, commit) !== scope.base) throw new Error("发布提交不是本次验收基准的后续提交");
  const changed = git(cwd, "diff", "--no-renames", "--name-only", "-z", scope.base, commit, "--")
    .split("\0")
    .filter(Boolean);
  if (changed.some((file) => !file.startsWith(scope.folder + "/"))) throw new Error("发布包含本次验收目录之外的修改");
  if (git(cwd, "remote", "get-url", "--push", "origin") !== scope.remote) throw new Error("发布远端与授权测试仓库不符");
}

export function loseMutationReplies(io: PublishIO, record: (kind: "push" | "create") => void): PublishIO {
  return {
    remoteHead: io.remoteHead,
    pulls: io.pulls,
    push(commit) {
      io.push(commit);
      record("push");
      throw new Error("验收注入：真实推送成功后丢弃响应");
    },
    async create() {
      await io.create();
      record("create");
      throw new Error("验收注入：真实 PR 创建成功后丢弃响应");
    },
  };
}

if (import.meta.main) {
  try {
    const [configuration, state, evidence, scope] = process.argv.slice(2);
    if (!configuration || !state || !evidence || !scope)
      throw new Error("验收发布需要配置、执行记录、故障记录和授权范围");
    const result = await runPublication(configuration, state, false, (cwd, request) => {
      checkPublicationScope(cwd, request.commit, JSON.parse(scope));
      return loseMutationReplies(createPublishIO(cwd, request), (kind) => {
        appendFileSync(
          evidence,
          JSON.stringify({ kind, commit: request.commit, branch: request.branch, at: new Date().toISOString() }) + "\n",
          { mode: 0o600 },
        );
      });
    });
    console.log(
      `已核对真实发布结果\n\n\`\`\`agent-autoloop-workflow\n${JSON.stringify({ decision: "pass", output: result })}\n\`\`\``,
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
