// Workflow transitions are facts. Workers receive only admitted steps from the frozen definition.
import { credential } from "./credentials.ts";
import { AuthError, Conflict, InputError, NotFound } from "./errors.ts";
import { rows, type Row, type Table } from "./evolve.ts";
import type { Draft } from "./decide.ts";
import type { Rule } from "./rules.ts";
import { addUsage } from "../protocol/validate.ts";
import {
  checkWorkflowChildren,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowStep,
} from "../protocol/workflow.ts";

type Ops = {
  put(draft: Draft, table: Table, key: string | number, fields: Row): Row;
  add(draft: Draft, table: Table, fields: Row): Row;
  createCard(draft: Draft, spec: Row): { card: number; duplicate: boolean };
};
const list = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const terminal = (state: string) => ["done", "failed", "cancelled"].includes(state);
const active = (draft: Draft, item: Row) =>
  rows(draft.view, "workflow_steps", { item: item.id, state: ["admitted", "running"] });
const rootOf = (draft: Draft, item: Row) => draft.view.get("workflows", item.root)!;
const definitionOf = (draft: Draft, item: Row): WorkflowDefinition =>
  rootOf(draft, item).frozenDefinitions[item.definition];
const ownerOf = (definition: WorkflowDefinition, fallback: string) =>
  definition.to ?? Object.values(definition.roles)[0]?.agent ?? fallback;

export function workflowFunctions(ops: Ops) {
  const { put, add, createCard } = ops;
  const get = (draft: Draft, id: number) => {
    const item = draft.view.get("workflows", id);
    if (!item) throw new NotFound("没有这个工作项");
    return item;
  };
  function create(draft: Draft, run: Row, rule: Rule) {
    if (!rule.workflow || run.workflow) return;
    const definition = draft.rules.workflows![rule.workflow];
    const id = (draft.view.next.workflows ?? 0) + 1;
    const owner = ownerOf(definition, rule.to);
    const item = add(draft, "workflows", {
      root: id,
      parent: null,
      run: run.id,
      definition: rule.workflow,
      worker: draft.rules.agents[owner].worker,
      agent: owner,
      cwd: (definition.cwd ?? rule.cwd).replaceAll("{item}", String(id)),
      depth: 0,
      input: {},
      dependencies: [],
      state: "ready",
      pending: list(definition.start),
      outputs: {},
      sessions: {},
      paused: false,
      cancel: false,
      reason: "",
      progress_at: draft.at,
      created_at: draft.at,
      frozenDefinitions: draft.rules.workflows,
      frozenAgents: draft.rules.agents,
      frozenRule: rule,
      budget: definition.budget,
      usage: { turns: 0, activeMs: 0, children: 0, tokens: {}, missingTokens: 0, missingCost: 0 },
    });
    put(draft, "runs", run.id, { workflow: item.id, worker: item.worker, agent: owner });
  }
  function paused(draft: Draft, item: Row): boolean {
    for (
      let current: Row | undefined = item;
      current;
      current = current.parent === null ? undefined : draft.view.get("workflows", current.parent)
    ) {
      if (current.paused) return true;
    }
    return false;
  }
  function claimable(draft: Draft, run: Row, worker: string): boolean {
    const item = get(draft, run.workflow);
    if (item.worker !== worker || paused(draft, item) || item.cancel || !["ready", "running"].includes(item.state))
      return false;
    if ((item.dependencies as number[]).some((id) => get(draft, id).state !== "done")) return false;
    // One writable directory belongs to one active item; each child's configured directory is distinct.
    return !rows(draft.view, "workflows", {
      worker: item.worker,
      cwd: item.cwd,
      state: ["ready", "running", "waiting", "paused", "blocked", "cancelling"],
    }).some((other) => other.id < item.id);
  }
  function release(draft: Draft, item: Row) {
    const run = draft.view.get("runs", item.run)!;
    const state = terminal(item.state) ? item.state : "waiting";
    put(draft, "runs", run.id, {
      state,
      last_issued: run.issued ?? run.last_issued,
      issued: null,
      claim: null,
      summary: item.outputs ? (Object.values(item.outputs as Record<string, Row>).at(-1)?.summary ?? "") : "",
      error: item.reason || null,
      cancel_at: item.cancel && !terminal(item.state) ? run.cancel_at : null,
      ...(terminal(item.state) && { finished_at: draft.at }),
    });
  }
  function wake(draft: Draft, item: Row) {
    if (terminal(item.state) || item.cancel) return;
    put(draft, "workflows", item.id, {
      state: paused(draft, item) ? "paused" : "ready",
      before_pause: "ready",
      reason: "",
    });
    const run = draft.view.get("runs", item.run)!;
    if (run.state !== "claimed")
      put(draft, "runs", run.id, {
        state: "queued",
        attempts: run.attempts + 1,
        not_before: draft.at,
        claim: null,
        issued: null,
        claimed_at: null,
        seen_at: null,
        finished_at: null,
        error: null,
      });
  }
  function route(draft: Draft, item: Row, execution: Row, result: Row) {
    const step = definitionOf(draft, item).steps[execution.step];
    const needsDecision = Object.keys(step.on ?? {}).some(
      (name) => !["done", "failed", "waiting", "cancelled", "blocked"].includes(name),
    );
    if (result.outcome === "done" && needsDecision && result.decision === undefined && !step.on?.done) {
      put(draft, "workflows", item.id, {
        state: "blocked",
        reason: `步骤 ${execution.step} 没有返回配置要求的决定`,
        progress_at: draft.at,
      });
      return;
    }
    if (result.decision !== undefined && step.on && !Object.hasOwn(step.on, result.decision)) {
      put(draft, "workflows", item.id, {
        state: "blocked",
        reason: `步骤 ${execution.step} 返回了没有配置的决定：${result.decision}`,
        progress_at: draft.at,
      });
      return;
    }
    const next =
      step.on?.[result.decision ?? result.outcome] ??
      step.on?.[result.outcome] ??
      (result.outcome === "done" ? step.next : undefined);
    const outputs = { ...item.outputs, [execution.step]: { ...result, attempt: execution.attempt } };
    const pending = [...new Set([...(item.pending as string[]), ...list(next)])];
    put(draft, "workflows", item.id, {
      outputs,
      pending,
      reason: "",
      progress_at: draft.at,
      ...(result.outcome === "failed" && next === undefined ? { reason: result.summary ?? "步骤没有完成" } : {}),
    });
    if (result.outcome === "failed" && next === undefined) {
      if (active(draft, item).length || hasLiveDescendants(draft, item)) {
        put(draft, "workflows", item.id, { failure: result.summary ?? "步骤没有完成" });
        control(draft, item.id, "cancel", "工作流", { reason: result.summary ?? "步骤没有完成" });
      } else put(draft, "workflows", item.id, { state: "failed" });
    }
  }
  function completed(draft: Draft, item: Row, given: Row) {
    const execution = draft.view.get("workflow_steps", given.execution);
    if (!execution || execution.item !== item.id) throw new AuthError("这个执行次数不属于本工作项");
    if (!["admitted", "running"].includes(execution.state)) {
      if (JSON.stringify(execution.result) !== JSON.stringify(given))
        throw new Conflict("这个执行次数已交过不同的结果");
      return;
    }
    const root = rootOf(draft, item);
    const agentTurn = execution.kind === "agent";
    const usage = {
      ...root.usage,
      activeMs: root.usage.activeMs + (given.activeMs ?? Math.max(0, draft.now - execution.started_ms)),
      tokens: addUsage(root.usage.tokens, given.usage) ?? {},
      missingTokens:
        root.usage.missingTokens +
        (agentTurn && given.usage?.input === undefined && given.usage?.output === undefined ? 1 : 0),
      missingCost: root.usage.missingCost + (agentTurn && given.usage?.cost === undefined ? 1 : 0),
    };
    put(draft, "workflows", root.id, { usage });
    if (given.usage) {
      const run = draft.view.get("runs", item.run)!;
      put(draft, "runs", run.id, {
        usage: JSON.stringify(addUsage(run.usage ? JSON.parse(run.usage) : undefined, given.usage)),
      });
    }
    put(draft, "workflow_steps", execution.id, {
      state: given.outcome,
      result: given,
      finished_at: draft.at,
      ...(given.session && { session: given.session }),
    });
    item = get(draft, item.id);
    if (given.session && execution.role)
      put(draft, "workflows", item.id, { sessions: { ...item.sessions, [execution.role]: given.session } });
    item = get(draft, item.id);
    if (item.cancel || given.outcome === "cancelled") return;
    if (given.outcome === "blocked") {
      put(draft, "workflows", item.id, {
        state: "blocked",
        reason: given.summary ?? "执行结果不确定，等待核对",
        progress_at: draft.at,
      });
      return;
    }
    if (given.outcome === "waiting") {
      if (!given.ask?.length) throw new InputError("等待人工回答的步骤要附上问题卡片");
      for (const [index, ask] of given.ask.entries())
        createCard(draft, {
          ...ask,
          key: `workflow:${item.id}:${execution.id}:${index}`,
          kind: "ask",
          rule: root.frozenRule.name,
          lane: `workflow:${item.id}`,
          grp: root.frozenRule.group,
          source: null,
          agent: execution.agent,
          session: given.session ?? execution.session,
          run: item.run,
          workflow: item.id,
          execution: execution.id,
        });
      put(draft, "workflows", item.id, { state: "waiting", reason: "等待人工回答", progress_at: draft.at });
      return;
    }
    route(draft, item, execution, given);
  }
  function children(draft: Draft, item: Row, execution: Row, step: Extract<WorkflowStep, { kind: "workflow" }>) {
    const root = rootOf(draft, item);
    const plan =
      step.children ??
      (step.template ? [{ id: "child", template: step.template }] : item.outputs[step.planFrom!]?.output?.children);
    const allowed = step.templates ?? (step.template ? [step.template] : step.children!.map((child) => child.template));
    const issues = checkWorkflowChildren(plan, allowed);
    if (issues.length) {
      const result = {
        execution: execution.id,
        outcome: "failed",
        summary: issues.join("；").slice(0, 500),
        output: plan,
      };
      put(draft, "workflow_steps", execution.id, { state: "failed", result, finished_at: draft.at });
      route(draft, item, execution, result);
      return;
    }
    if (item.depth + 1 > root.budget.depth || root.usage.children + plan.length > root.budget.children) {
      put(draft, "workflows", item.id, { state: "blocked", reason: "子项数量或递归深度达到根工作流上限" });
      put(draft, "workflow_steps", execution.id, { state: "blocked", result: { outcome: "blocked" } });
      return;
    }
    const ids = new Map<string, number>();
    const created: Row[] = [];
    for (const child of plan) {
      const def: WorkflowDefinition = root.frozenDefinitions[child.template];
      const childId = (draft.view.next.workflows ?? 0) + 1;
      const cwd = def.cwd!.replaceAll("{item}", String(childId));
      if (cwd === item.cwd || rows(draft.view, "workflows", { root: root.id }).some((other) => other.cwd === cwd)) {
        throw new InputError("子工作项要配置独立目录，可在 cwd 中用 {item}");
      }
      const owner = ownerOf(def, item.agent);
      const run = add(draft, "runs", {
        workflow: childId,
        worker: root.frozenAgents[owner].worker,
        rule: root.frozenRule.name,
        agent: owner,
        grp: root.frozenRule.group,
        lane: `workflow:${childId}`,
        state: "queued",
        rules_version: draft.view.get("runs", item.run)!.rules_version,
        created_at: draft.at,
        not_before: draft.at,
      });
      const childItem = add(draft, "workflows", {
        root: root.id,
        parent: item.id,
        parent_execution: execution.id,
        run: run.id,
        definition: child.template,
        worker: root.frozenAgents[owner].worker,
        agent: owner,
        cwd,
        depth: item.depth + 1,
        input: { data: child.input, goal: child.goal },
        dependencies: [],
        plan_id: child.id,
        state: "ready",
        pending: list(def.start),
        outputs: {},
        sessions: {},
        paused: false,
        cancel: false,
        reason: "",
        progress_at: draft.at,
        created_at: draft.at,
      });
      ids.set(child.id, childItem.id);
      created.push(childItem);
    }
    for (const [index, child] of plan.entries())
      put(draft, "workflows", created[index].id, {
        dependencies: (child.after ?? []).map((name: string) => ids.get(name)),
      });
    put(draft, "workflows", root.id, { usage: { ...root.usage, children: root.usage.children + plan.length } });
    put(draft, "workflow_steps", execution.id, {
      state: "waiting",
      children: created.map((child) => child.id),
      plan,
      started_ms: draft.now,
    });
    put(draft, "workflows", item.id, { state: "waiting", reason: "等待子工作项", progress_at: draft.at });
  }
  function settleParents(draft: Draft, child: Row) {
    if (child.parent === null) return;
    const parent = get(draft, child.parent);
    const execution = draft.view.get("workflow_steps", child.parent_execution)!;
    if (execution.state !== "waiting") return;
    let siblings = (execution.children as number[]).map((id) => get(draft, id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const stored of siblings) {
        const dependent = get(draft, stored.id);
        if (
          !terminal(dependent.state) &&
          !active(draft, dependent).length &&
          dependent.dependencies.some((id: number) => {
            const dependency = get(draft, id);
            return terminal(dependency.state) && dependency.state !== "done";
          })
        ) {
          put(draft, "workflows", dependent.id, {
            state: "failed",
            reason: "前置子工作项没有完成",
            progress_at: draft.at,
          });
          release(draft, get(draft, dependent.id));
          changed = true;
        }
      }
    }
    siblings = (execution.children as number[]).map((id) => get(draft, id));
    if (!siblings.every((item) => terminal(item.state))) return;
    if (parent.cancel) {
      put(draft, "workflow_steps", execution.id, { state: "cancelled", finished_at: draft.at });
      if (active(draft, parent).length || hasLiveDescendants(draft, parent)) {
        put(draft, "workflows", parent.id, { state: "cancelling", progress_at: draft.at });
        return;
      }
      put(draft, "workflows", parent.id, { state: parent.failure ? "failed" : "cancelled", progress_at: draft.at });
      release(draft, get(draft, parent.id));
      settleParents(draft, get(draft, parent.id));
      return;
    }
    const outcome = siblings.every((item) => item.state === "done") ? "done" : "failed";
    const result = {
      execution: execution.id,
      outcome,
      output: siblings.map(({ id, state, outputs }) => ({ id, state, outputs })),
      summary: outcome === "done" ? "子工作项已完成" : "子工作项没有全部完成",
    };
    put(draft, "workflow_steps", execution.id, { state: outcome, result, finished_at: draft.at });
    route(draft, parent, execution, result);
    const current = get(draft, parent.id);
    if (!terminal(current.state)) wake(draft, current);
    else {
      if (!active(draft, current).length) release(draft, current);
      settleParents(draft, current);
    }
  }
  function executionView(draft: Draft, item: Row, execution: Row): WorkflowExecution {
    const root = rootOf(draft, item),
      def = definitionOf(draft, item),
      step = def.steps[execution.step];
    const role = step.kind === "agent" ? def.roles[step.role] : undefined;
    const registered = role && root.frozenAgents[role.agent];
    const inputs = step.input ? Object.fromEntries(step.input.map((name) => [name, item.outputs[name]])) : item.outputs;
    return {
      id: execution.id,
      step: execution.step,
      attempt: execution.attempt,
      kind: step.kind,
      cwd: item.cwd,
      session: execution.session ?? null,
      ...(execution.time_limit_ms !== undefined && { timeLimitMs: execution.time_limit_ms }),
      ...(step.kind === "agent" && {
        role: step.role,
        agent: {
          ...registered,
          id: role!.agent,
          ...(role!.model && { model: role!.model }),
          ...(role!.effort && { effort: role!.effort }),
        },
        prompt: [role!.prompt, step.prompt].filter(Boolean).join("\n"),
        skill: step.skill ?? role!.skill,
      }),
      ...(step.kind === "command" && { command: step.command, reconcile: step.reconcile }),
      input: {
        data: item.input,
        outputs: inputs,
        answers: execution.answers ?? [],
        dependencies: (item.dependencies as number[]).map((id) => {
          const dependency = get(draft, id);
          return { item: dependency.id, id: dependency.plan_id, outputs: dependency.outputs };
        }),
      },
      outputs: item.outputs,
      goal: root.frozenRule.prompt ?? "",
      decisions: Object.keys(step.on ?? {}),
    };
  }
  function response(draft: Draft, item: Row) {
    const executions = active(draft, item);
    const canRelease =
      !executions.length && (terminal(item.state) || ["waiting", "paused", "blocked"].includes(item.state));
    if (canRelease) release(draft, item);
    return {
      item: item.id,
      root: item.root,
      state: item.state,
      release: canRelease,
      cancel: item.cancel,
      executions: executions.map((execution) => executionView(draft, item, execution)),
    };
  }
  function advance(draft: Draft, runId: number, token: string, given: Row = {}) {
    const run = draft.view.get("runs", runId);
    if (!run?.workflow) throw new AuthError("这个令牌没有工作流任务");
    if (run.issued === null || credential(draft.env, "run", runId, run.issued) !== token) {
      if (run.last_issued !== null && credential(draft.env, "run", runId, run.last_issued) === token) {
        const old = get(draft, run.workflow);
        return { item: old.id, root: old.root, state: old.state, cancel: old.cancel, executions: [], release: true };
      }
      throw new AuthError("这件活不归这个令牌");
    }
    let item = get(draft, run.workflow);
    for (const report of [...(given.progress ?? []), ...(given.blocked ?? [])]) {
      const execution = draft.view.get("workflow_steps", report.execution);
      if (!execution || execution.item !== item.id) throw new AuthError("这个执行次数不属于本工作项");
      if (!["admitted", "running"].includes(execution.state)) continue;
      const blocked = (given.blocked ?? []).includes(report);
      const field = blocked ? "blocked_reason" : "progress";
      if (execution[field] === report.summary) continue;
      put(draft, "workflow_steps", execution.id, { [field]: report.summary, progress_at: draft.at });
      put(draft, "workflows", item.id, { reason: blocked ? report.summary : item.reason, progress_at: draft.at });
    }
    for (const started of given.started ?? []) {
      const execution = draft.view.get("workflow_steps", started.execution);
      if (!execution || execution.item !== item.id) throw new AuthError("这个执行次数不属于本工作项");
      if (["admitted", "running"].includes(execution.state)) {
        put(draft, "workflow_steps", execution.id, {
          state: "running",
          session: started.session,
          turn: started.turn ?? execution.turn ?? null,
          progress_at: draft.at,
          ...(execution.session &&
            execution.session !== started.session && {
              previous_session: execution.session,
              context_rebuilt: "Agent 报告原会话不可续接，已重建上下文",
            }),
        });
        if (execution.role)
          put(draft, "workflows", item.id, {
            sessions: { ...get(draft, item.id).sessions, [execution.role]: started.session },
            progress_at: draft.at,
          });
      }
    }
    for (const result of given.completed ?? []) completed(draft, get(draft, item.id), result);
    item = get(draft, item.id);
    if (item.cancel) {
      put(draft, "workflows", item.id, {
        state:
          active(draft, item).length || hasLiveDescendants(draft, item)
            ? "cancelling"
            : item.failure
              ? "failed"
              : "cancelled",
      });
    } else if (!terminal(item.state) && item.state !== "blocked") {
      if (paused(draft, item))
        put(draft, "workflows", item.id, { state: "paused", reason: "已请求暂停；已准入步骤在收尾" });
      else if (item.state !== "waiting" && !active(draft, item).some((execution) => execution.blocked_reason)) {
        const def = definitionOf(draft, item);
        let capacity = given.capacity ?? 1;
        for (const name of item.pending as string[]) {
          if (capacity <= 0) break;
          item = get(draft, item.id);
          const step = def.steps[name];
          const previous = rows(draft.view, "workflow_steps", { item: item.id, step: name }, 1, true)[0];
          if (active(draft, item).some((execution) => execution.step === name)) continue;
          if (
            step.after?.some(
              (dependency) =>
                !item.outputs[dependency] || (previous && item.outputs[dependency].execution <= previous.id),
            )
          )
            continue;
          if (step.kind === "agent" && active(draft, item).some((execution) => execution.role === step.role)) continue;
          const root = rootOf(draft, item);
          const allActive = rows(draft.view, "workflow_steps", { root: root.id, state: ["admitted", "running"] });
          if (allActive.length >= root.budget.concurrency) break;
          if (
            (previous?.attempt ?? 0) >= (step.maxAttempts ?? 1) ||
            root.usage.activeMs >= root.budget.activeMs ||
            (step.kind === "agent" && root.usage.turns >= root.budget.turns)
          ) {
            put(draft, "workflows", item.id, {
              state: "blocked",
              reason: "步骤次数、Agent 轮数或活动时间达到根工作流上限",
            });
            break;
          }
          // Reserve time before dispatch: disconnected workers still have a finite share of the root's budget.
          const availableMs =
            root.budget.activeMs -
            root.usage.activeMs -
            allActive.reduce((sum, held) => sum + (held.time_limit_ms ?? 0), 0);
          if (step.kind !== "workflow" && availableMs < 1) break;
          const timeLimitMs = Math.max(
            1,
            Math.floor(availableMs / Math.min(capacity, root.budget.concurrency - allActive.length)),
          );
          const execution = add(draft, "workflow_steps", {
            root: root.id,
            item: item.id,
            step: name,
            kind: step.kind,
            attempt: (previous?.attempt ?? 0) + 1,
            state: "admitted",
            role: step.kind === "agent" ? step.role : null,
            session: step.kind === "agent" ? (item.sessions[step.role] ?? null) : null,
            agent: step.kind === "agent" ? def.roles[step.role].agent : item.agent,
            started_ms: draft.now,
            started_at: draft.at,
            progress_at: draft.at,
            result: null,
            answers: item.answers?.[name] ?? [],
            ...(step.kind !== "workflow" && { time_limit_ms: timeLimitMs }),
          });
          const answers = { ...item.answers };
          delete answers[name];
          put(draft, "workflows", item.id, {
            pending: item.pending.filter((candidate: string) => candidate !== name),
            answers,
            state: "running",
            progress_at: draft.at,
          });
          if (step.kind === "workflow") children(draft, get(draft, item.id), execution, step);
          else {
            if (step.kind === "agent")
              put(draft, "workflows", root.id, {
                usage: { ...rootOf(draft, item).usage, turns: root.usage.turns + 1 },
              });
            capacity--;
          }
        }
        item = get(draft, item.id);
        if (!item.pending.length && !active(draft, item).length && ["ready", "running"].includes(item.state)) {
          const waiting = rows(draft.view, "workflow_steps", { item: item.id, state: "waiting" }).some(
            (step) =>
              step.kind === "workflow" || rows(draft.view, "cards", { execution: step.id, state: "open" }).length,
          );
          put(draft, "workflows", item.id, { state: waiting ? "waiting" : "done", progress_at: draft.at });
        }
      }
    }
    item = get(draft, item.id);
    if (terminal(item.state)) settleParents(draft, item);
    return response(draft, item);
  }
  function answered(draft: Draft, card: Row) {
    const item = get(draft, card.workflow);
    const execution = draft.view.get("workflow_steps", card.execution)!;
    const cards = rows(draft.view, "cards", { workflow: item.id, execution: execution.id });
    if (cards.some((question) => question.state === "open") || terminal(item.state) || item.cancel) return;
    const answers = cards.map(({ id, choice, answer, by, title, options }) => ({
      card: id,
      choice,
      text: answer,
      by,
      title,
      options: JSON.parse(options),
    }));
    put(draft, "workflows", item.id, {
      pending: [...new Set([...item.pending, execution.step])],
      answers: { ...item.answers, [execution.step]: answers },
      progress_at: draft.at,
    });
    wake(draft, get(draft, item.id));
  }
  function control(draft: Draft, id: number, action: string, by: string, given: Row = {}) {
    const target = get(draft, id);
    if (!["pause", "resume", "cancel"].includes(action))
      throw new InputError("工作流操作只能是 pause、resume 或 cancel");
    const affected = rows(draft.view, "workflows", { root: target.root }).filter((item) => {
      for (
        let ancestor: Row | undefined = item;
        ancestor;
        ancestor = ancestor.parent === null ? undefined : draft.view.get("workflows", ancestor.parent)
      )
        if (ancestor.id === id) return true;
      return false;
    });
    if (action === "pause")
      put(draft, "workflows", id, {
        paused: true,
        reason: given.reason ?? "本人请求暂停",
        controlled_by: by,
        control_at: draft.at,
      });
    if (action === "resume") put(draft, "workflows", id, { paused: false, controlled_by: by, control_at: draft.at });
    for (const original of affected) {
      let item = get(draft, original.id);
      if (terminal(item.state)) continue;
      const run = draft.view.get("runs", item.run)!;
      if (action === "cancel") {
        for (const card of rows(draft.view, "cards", { workflow: item.id, state: "open" }))
          put(draft, "cards", card.id, {
            state: "closed",
            result: "工作项已取消",
            closed_at: draft.at,
            version: card.version + 1,
          });
        const going = active(draft, item).length > 0 || hasLiveDescendants(draft, item);
        put(draft, "workflows", item.id, {
          cancel: true,
          state: going ? "cancelling" : item.failure ? "failed" : "cancelled",
          reason: given.reason ?? "本人请求取消",
          controlled_by: by,
          control_at: draft.at,
        });
        if (going) put(draft, "runs", run.id, { cancel_at: draft.at });
        else {
          item = get(draft, item.id);
          release(draft, item);
          settleParents(draft, item);
        }
      } else if (action === "pause") {
        if (!active(draft, item).length && item.state !== "paused") {
          put(draft, "workflows", item.id, {
            before_pause: item.state,
            before_pause_reason: original.reason,
            state: "paused",
          });
          release(draft, get(draft, item.id));
        }
      } else if (item.state === "paused" && !paused(draft, item)) {
        if (["waiting", "blocked"].includes(item.before_pause))
          put(draft, "workflows", item.id, { state: item.before_pause, reason: item.before_pause_reason ?? "" });
        else wake(draft, item);
      }
    }
    return get(draft, id);
  }
  function hasLiveDescendants(draft: Draft, item: Row): boolean {
    return rows(draft.view, "workflows", { parent: item.id }).some((child) => !terminal(child.state));
  }
  return { create, claimable, advance, control, answered };
}
