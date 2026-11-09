// Publication is a command step after local review and tests. The remote branch and PR are its recovery record.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { github } from "../../plugins/delivery/github.ts";
import { git, REPO } from "../../plugins/delivery/project.ts";

type PublishConfig = { repo: string; remote: string; branch: string; base: string; title: string; bodyFile: string };
export type PublishRequest = Omit<PublishConfig, "bodyFile"> & { body: string; commit: string };
type Pull = {
  number: number;
  html_url: string;
  state: string;
  merged_at?: string | null;
  head: { sha: string; ref: string };
  base: { ref: string };
};
export type PublishIO = {
  remoteHead(): string | null;
  push(commit: string): void;
  pulls(): Promise<Pull[]>;
  create(): Promise<unknown>;
};
type Published = { url: string; number: number; commit: string; branch: string };

export function publishConfig(value: any, item?: number): PublishConfig {
  if (!value || !REPO.test(value.repo ?? "")) throw new Error("发布配置的 repo 要写成 owner/name");
  for (const field of ["remote", "branch", "base", "title", "bodyFile"])
    if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`发布配置缺少 ${field}`);
  if (!/^[\w.-]+$/.test(value.remote) || value.remote.startsWith("-")) throw new Error("remote 要是已配置的远端名称");
  let branch = value.branch;
  if (branch.includes("{item}")) {
    if (!Number.isSafeInteger(item) || item! <= 0) throw new Error("分支中的 {item} 需要工作项编号");
    branch = branch.replaceAll("{item}", String(item));
  }
  for (const ref of [branch, value.base])
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) ||
      ref.includes("..") ||
      ref.includes("//") ||
      ref.endsWith("/") ||
      ref.split("/").some((part: string) => part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
    )
      throw new Error("发布分支和目标分支的名字不正确");
  if (branch === value.base) throw new Error("发布分支不能是目标分支");
  return {
    repo: value.repo,
    remote: value.remote,
    branch,
    base: value.base,
    title: value.title,
    bodyFile: value.bodyFile,
  };
}

export function createPublishIO(cwd: string, request: PublishRequest): PublishIO {
  const api = github(request.repo);
  const destination = git(cwd, "remote", "get-url", "--push", request.remote);
  const query = new URLSearchParams({
    state: "all",
    head: `${request.repo.split("/")[0]}:${request.branch}`,
    base: request.base,
    per_page: "100",
  });
  return {
    remoteHead() {
      const output = git(cwd, "ls-remote", destination, `refs/heads/${request.branch}`);
      return output ? output.split(/\s+/)[0] : null;
    },
    push: (commit) => {
      git(cwd, "push", destination, `${commit}:refs/heads/${request.branch}`);
    },
    pulls: () => api(`pulls?${query}`),
    create: () => api("pulls", { head: request.branch, base: request.base, title: request.title, body: request.body }),
  };
}

export async function publish(request: PublishRequest, io: PublishIO, reconcile = false): Promise<Published | null> {
  let remote = io.remoteHead();
  if (remote && remote !== request.commit) throw new Error("远端分支已有别的提交，未覆盖；请核对工作项与发布分支");
  if (!remote) {
    if (reconcile) return null;
    let failure: unknown;
    try {
      io.push(request.commit);
    } catch (error) {
      failure = error;
    }
    remote = io.remoteHead();
    if (remote !== request.commit) throw failure ?? new Error("推送后没有读到预期提交，保留执行记录等待核对");
  }
  const existing = async (): Promise<Published | null> => {
    const pulls = (await io.pulls()).filter((pr) => pr.head.ref === request.branch && pr.base.ref === request.base);
    if (!pulls.length) return null;
    const pr = pulls[0];
    if (pr.head.sha !== request.commit) throw new Error("已有 PR 的提交不符，未创建另一个 PR");
    if (pr.state === "closed" && !pr.merged_at) throw new Error("已有 PR 已关闭且未合并，未重新创建");
    return { url: pr.html_url, number: pr.number, commit: request.commit, branch: request.branch };
  };
  const found = await existing();
  if (found || reconcile) return found;
  let failure: unknown;
  try {
    await io.create();
  } catch (error) {
    failure = error;
  }
  const observed = await existing();
  if (!observed) throw failure ?? new Error("创建 PR 后无法读回结果，保留执行记录等待核对");
  return observed;
}

export async function runPublication(
  configuration: string,
  stateFile: string,
  reconcile = false,
  io: (cwd: string, request: PublishRequest) => PublishIO = createPublishIO,
) {
  if (reconcile && !existsSync(stateFile)) return null;
  let request: PublishRequest;
  if (existsSync(stateFile)) request = JSON.parse(readFileSync(stateFile, "utf8"));
  else {
    const context = process.env.AGENT_AUTOLOOP_CONTEXT
      ? JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT, "utf8"))
      : {};
    const config = publishConfig(JSON.parse(configuration), context.workflow?.item);
    if (git(process.cwd(), "status", "--porcelain"))
      throw new Error("工作区还有未提交改动；请先提交已审查并测试的结果");
    const { bodyFile, ...fields } = config;
    request = {
      ...fields,
      body: readFileSync(path.resolve(process.cwd(), bodyFile), "utf8"),
      commit: git(process.cwd(), "rev-parse", "HEAD"),
    };
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(request), { mode: 0o600 });
    renameSync(`${stateFile}.tmp`, stateFile);
  }
  return publish(request, io(process.cwd(), request), reconcile);
}

if (import.meta.main) {
  try {
    const [configuration, stateFile, mode] = process.argv.slice(2);
    if (!configuration || !stateFile || (mode && mode !== "--reconcile"))
      throw new Error("用法：node publish.ts <已冻结的发布配置JSON> <本次执行记录.json> [--reconcile]");
    const result = await runPublication(configuration, stateFile, mode === "--reconcile");
    if (!result) {
      console.log("发布结果尚未确认，未重复推送或创建 PR。");
      process.exitCode = 3;
    } else {
      console.log(
        `已核实 PR：${result.url}\n\n\`\`\`agent-autoloop-workflow\n${JSON.stringify({ decision: "pass", output: result })}\n\`\`\``,
      );
    }
  } catch (error) {
    console.error(`发布未完成：${(error as Error).message}`);
    process.exitCode = 1;
  }
}
