import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { git } from "../../plugins/delivery/project.ts";

export function prepare(source: string, base: string, workspace: string, item: number) {
  const branch = `codex/work-${item}`;
  if (existsSync(path.join(workspace, ".git"))) {
    const common = (cwd: string) => realpathSync(path.resolve(cwd, git(cwd, "rev-parse", "--git-common-dir")));
    if (git(workspace, "branch", "--show-current") !== branch || common(source) !== common(workspace)) {
      throw new Error("工作目录已经属于别的分支或仓库，未替换");
    }
  } else {
    // A stopped worktree creation may already have written the branch reference.
    const existing = git(source, "for-each-ref", "--format=%(refname)", `refs/heads/${branch}`);
    git(source, "worktree", "add", ...(existing ? [] : ["-b", branch]), workspace, existing ? branch : base);
  }
  return { branch, commit: git(workspace, "rev-parse", "HEAD"), workspace };
}

export function commitWork(workspace: string, item: number) {
  if (git(workspace, "status", "--porcelain")) {
    git(workspace, "add", "--all");
    git(workspace, "commit", "-m", `工作流 #${item}：交付修改`);
  }
  return git(workspace, "rev-parse", "HEAD");
}

if (import.meta.main) {
  const context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8"));
  const item = context.workflow.item;
  if (!Number.isSafeInteger(item) || item <= 0) throw new Error("缺少工作项编号");
  const mode = process.argv[2];
  let output;
  if (mode === "prepare") {
    const config = JSON.parse(process.argv[3]);
    if (typeof config.source !== "string" || typeof config.base !== "string") {
      throw new Error("仓库配置要有 source 目录和 base 分支");
    }
    const source = config.source.replace(/^~(?=[/\\])/, homedir());
    if (!path.isAbsolute(source) || config.base.startsWith("-")) throw new Error("仓库目录或分支不正确");
    output = prepare(source, config.base, process.cwd(), item);
  } else if (mode === "commit") output = { commit: commitWork(process.cwd(), item) };
  else throw new Error("用法：node repository.ts prepare <已冻结的仓库配置JSON>，或 node repository.ts commit");
  console.log(`已完成 ${mode}`);
  console.log(`\n\`\`\`agent-autoloop-workflow\n${JSON.stringify({ output })}\n\`\`\``);
}
