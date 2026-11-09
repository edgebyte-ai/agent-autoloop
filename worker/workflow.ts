// The hub owns transitions and budgets. This journal only keeps admitted executions and unacknowledged results.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Job } from "../protocol/job.ts";
import type { WorkflowAdvance, WorkflowAdvanceResult, WorkflowExecution } from "../protocol/workflow.ts";
import type { Result } from "../protocol/validate.ts";
import type { ExecutionHandle } from "./worker.ts";
import { workflowContext, workflowPrompt, workflowResult } from "./workflow-result.ts";

type Completion = ReturnType<typeof workflowResult>;
export type WorkflowHub = {
  workflowAdvance(run: number, token: string, body: WorkflowAdvance): Promise<WorkflowAdvanceResult>;
};
type SavedExecution = {
  execution: WorkflowExecution;
  completion?: Completion;
  accepted?: boolean;
  session?: string;
  turn?: string;
  progress?: string;
  blocked?: string;
  reconciling?: boolean;
  uncertainMs?: number;
};
type Journal = { executions: Record<string, SavedExecution>; cancelling: boolean };
type Options = {
  job: Job;
  dir: string;
  hub: WorkflowHub;
  execute(job: Job, dir: string, prompt?: string, options?: { timeLimitMs?: number }): Promise<ExecutionHandle>;
  capacity: number | (() => number);
  log?: (line: string) => void;
  now?: () => number;
};

export function createWorkflowDriver({ job, dir, hub, execute, capacity, log = () => {} }: Options) {
  const file = path.join(dir, "workflow.json");
  const journal: Journal = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : { executions: {}, cancelling: false };
  const handles = new Map<string, ExecutionHandle>();
  const stopped = new Set<string>();
  const save = () => {
    writeFileSync(`${file}.tmp`, JSON.stringify(journal), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  const pending = () => Object.values(journal.executions).filter((entry) => !entry.accepted);
  const active = () => pending().filter((entry) => !entry.completion).length;
  const executionFolder = (entry: SavedExecution, reconcile = false) =>
    path.join(dir, `execution-${entry.execution.id}`, ...(reconcile ? ["reconcile"] : []));
  function retain(entry: SavedExecution) {
    const result = entry.completion!;
    if (Buffer.byteLength(JSON.stringify(result.output) ?? "") <= 48 * 1024) return;
    const artifact = path.join(executionFolder(entry), "workflow-result.json");
    writeFileSync(`${artifact}.tmp`, JSON.stringify(result), { mode: 0o600 });
    renameSync(`${artifact}.tmp`, artifact);
    const structured = typeof result.output !== "string";
    const log = path.join(executionFolder(entry, entry.reconciling), "stdout-1.log");
    entry.completion = {
      ...result,
      ...(structured && {
        outcome: "blocked",
        summary: "结构化产出超过 48 KB，已保存原文；请缩小产出后再继续，未执行计划里的操作",
      }),
      output: {
        artifact,
        ...(existsSync(log) && { log }),
        preview:
          typeof result.output === "string" ? result.output.slice(0, 4000) : "结构化产出过大，完整内容见 artifact",
      },
    };
    save();
  }

  async function handle(entry: SavedExecution, reconcile = false) {
    const execution = entry.execution;
    const key = `${execution.id}${reconcile ? ":reconcile" : ""}`;
    let known = handles.get(key);
    if (known) return known;
    const folder = executionFolder(entry, reconcile);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const context = workflowContext(job, execution);
    writeFileSync(path.join(folder, "context.json"), JSON.stringify(context, null, 2), { mode: 0o600 });
    const cwd = execution.cwd.replace(/^~(?=[/\\])/, homedir());
    mkdirSync(cwd, { recursive: true });
    // Reconciliation reads the original operation's intent, even though its own process has a separate journal.
    const command = reconcile
      ? execution.reconcile?.map((part) =>
          part.replaceAll("{context}", path.join(executionFolder(entry), "context.json")),
        )
      : execution.command;
    const agent =
      execution.kind === "command" || reconcile
        ? { id: "command", name: "命令步骤", use: "command", access: "edit", command }
        : execution.agent!;
    // The nested execution uses the same worker machinery without becoming another workflow or queue entry.
    const stepJob: Job = {
      ...job,
      agent,
      session: reconcile ? null : execution.session,
      rule: {
        ...job.rule,
        name: `${job.rule.name}/${execution.step}`,
        cwd,
        prompt: execution.prompt,
        skill: execution.skill,
      },
      context,
    };
    delete stepJob.workflow;
    known = await execute(stepJob, folder, workflowPrompt(execution, path.join(folder, "context.json"), job.askFirst), {
      timeLimitMs:
        execution.timeLimitMs === undefined
          ? undefined
          : execution.timeLimitMs - (reconcile ? (entry.uncertainMs ?? 0) : 0),
    });
    handles.set(key, known);
    return known;
  }

  async function stop(entry: SavedExecution) {
    const key = `${entry.execution.id}${entry.reconciling ? ":reconcile" : ""}`;
    if (stopped.has(key) || entry.completion) return;
    // execute persists entry.json before it can start work. An admission alone is not a process to recover.
    if (!handles.has(key) && !existsSync(path.join(executionFolder(entry, entry.reconciling), "entry.json"))) {
      entry.completion = { execution: entry.execution.id, outcome: "cancelled", activeMs: 0, summary: "启动前已取消" };
      save();
      return;
    }
    await (await handle(entry, entry.reconciling)).cancel();
    stopped.add(key);
  }

  async function tick(): Promise<{ release: boolean; result?: Result }> {
    const started: NonNullable<WorkflowAdvance["started"]> = [];
    const progress: NonNullable<WorkflowAdvance["progress"]> = [];
    const blocked: NonNullable<WorkflowAdvance["blocked"]> = [];
    for (const entry of pending()) {
      if (entry.completion) continue;
      if (journal.cancelling) await stop(entry);
      if (entry.completion) continue;
      const running = await handle(entry, entry.reconciling);
      const { result, reading, activeMs } = await running.poll();
      if (reading.session && (reading.session !== entry.session || reading.turn !== entry.turn)) {
        started.push({
          execution: entry.execution.id,
          session: reading.session,
          ...(reading.turn && { turn: reading.turn }),
        });
      }
      if (reading.progress && reading.progress.slice(0, 500) !== entry.progress) {
        progress.push({ execution: entry.execution.id, summary: reading.progress.slice(0, 500) });
      }
      if (entry.reconciling) {
        if (result || (reading.blocked && reading.finished)) {
          const confirmed = result?.outcome === "done" || result?.outcome === "nothing";
          entry.completion = {
            ...workflowResult(
              entry.execution,
              result ?? { outcome: "failed", error: reading.error },
              reading.text ?? "",
              (entry.uncertainMs ?? 0) + activeMs,
            ),
            ...(!confirmed && {
              outcome: "blocked",
              summary: `核对未确认原命令已完成：${result?.error ?? reading.error ?? "没有完成记录"}`.slice(0, 500),
            }),
          };
          save();
        } else if (reading.blocked && reading.error?.slice(0, 500) !== entry.blocked) {
          blocked.push({
            execution: entry.execution.id,
            summary: (reading.error ?? "无法确认核对进程的实际状态").slice(0, 500),
          });
        }
      } else if (
        reading.blocked ||
        (result?.outcome === "failed" && entry.execution.kind === "command" && entry.execution.reconcile)
      ) {
        if (
          entry.execution.kind === "command" &&
          entry.execution.reconcile &&
          (reading.finished || result) &&
          !journal.cancelling &&
          (entry.execution.timeLimitMs === undefined || activeMs < entry.execution.timeLimitMs)
        ) {
          entry.reconciling = true;
          entry.uncertainMs = activeMs;
          save();
          await handle(entry, true);
        } else if (reading.finished || result) {
          entry.completion = {
            execution: entry.execution.id,
            outcome: "blocked",
            summary: reading.error ?? result?.error ?? "无法确认这次执行的实际状态，已停止后续步骤",
            ...(reading.session && { session: reading.session }),
            ...(reading.usage && { usage: reading.usage }),
            activeMs,
          };
          save();
        } else if (reading.error?.slice(0, 500) !== entry.blocked) {
          blocked.push({
            execution: entry.execution.id,
            summary: (reading.error ?? "无法确认这次执行的实际状态").slice(0, 500),
          });
        }
      } else if (result) {
        entry.completion = workflowResult(entry.execution, result, reading.text ?? "", activeMs);
        save();
      }
    }
    for (const entry of pending()) if (entry.completion) retain(entry);
    const ready = pending().flatMap((entry) => (entry.completion ? [entry.completion] : []));
    const completed: Completion[] = [];
    for (const result of ready) {
      if (Buffer.byteLength(JSON.stringify([...completed, result])) > 512 * 1024) break;
      completed.push(result);
    }
    // Changes not included here stay unacknowledged and are reported by a later poll.
    started.splice(32);
    progress.splice(32);
    blocked.splice(32);
    const response = await hub.workflowAdvance(job.run, job.token, {
      ...(completed.length && { completed }),
      ...(started.length && { started }),
      ...(progress.length && { progress }),
      ...(blocked.length && { blocked }),
      capacity:
        journal.cancelling || completed.length !== ready.length
          ? 0
          : Math.max(0, (typeof capacity === "function" ? capacity() : capacity) - active()),
    });
    for (const result of completed) journal.executions[result.execution].accepted = true;
    for (const item of started) {
      journal.executions[item.execution].session = item.session;
      journal.executions[item.execution].turn = item.turn;
    }
    for (const item of progress) journal.executions[item.execution].progress = item.summary;
    for (const item of blocked) journal.executions[item.execution].blocked = item.summary;
    if (response.cancel) journal.cancelling = true;
    for (const execution of response.executions) {
      if (!journal.executions[execution.id]) journal.executions[execution.id] = { execution };
    }
    save();
    for (const entry of pending()) {
      if (entry.completion) continue;
      if (journal.cancelling) await stop(entry);
      else await handle(entry, entry.reconciling);
    }
    if (response.release && pending().length === 0) {
      log(`workflow ${response.item}: ${response.state}`);
      return { release: true };
    }
    return { release: false };
  }

  async function cancel() {
    journal.cancelling = true;
    save();
    for (const entry of pending()) await stop(entry);
  }

  return { tick, cancel, active };
}
