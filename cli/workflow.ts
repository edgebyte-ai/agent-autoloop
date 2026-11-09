// These are the central's recorded facts; a heartbeat is not shown as work progress.
const STATES: Record<string, string> = {
  ready: "待执行",
  admitted: "已准入",
  queued: "排队",
  running: "执行中",
  waiting: "等待",
  paused: "已暂停",
  done: "已完成",
  failed: "失败",
  blocked: "阻塞",
  cancelled: "已取消",
  cancelling: "正在取消",
  claimed: "执行中",
};

const stateOf = (item: any) =>
  `${STATES[item.state] ?? item.state}${item.paused ? "，已请求暂停" : ""}${item.cancel ? "，已请求取消" : ""}`;
const words = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

function itemLines(item: any) {
  const lines = [`#${item.id} ${item.definition} · ${stateOf(item)} · worker ${item.worker}`];
  lines.push(`  根 #${item.root} · 父项 ${item.parent === null ? "无" : `#${item.parent}`} · 执行轮 #${item.run}`);
  if (item.cwd) lines.push(`  目录：${item.cwd}`);
  if (item.pending?.length) lines.push(`  待完成步骤：${item.pending.join("、")}`);
  if (item.dependencies?.length) lines.push(`  依赖：${item.dependencies.join("、")}`);
  if (item.reason) lines.push(`  等待或失败原因：${item.reason}`);
  if (item.progress_at) lines.push(`  最近实际进展：${item.progress_at}`);
  for (const [role, session] of Object.entries(item.sessions ?? {})) lines.push(`  角色 ${role}：${words(session)}`);
  if (item.usage) lines.push(`  累计用量：${words(item.usage)}`);
  if (item.budget) lines.push(`  上限：${words(item.budget)}`);
  if (item.outputs && Object.keys(item.outputs).length) lines.push(`  已完成结果：${words(item.outputs)}`);
  return lines;
}

export function workflowLines(data: any, detail: boolean) {
  if (!detail) {
    if (!data.workflows.length) return ["还没有工作流。"];
    return data.workflows.flatMap(itemLines);
  }
  const lines = data.items.flatMap(itemLines);
  for (const execution of data.executions) {
    lines.push(
      `执行 #${execution.id} · 工作项 #${execution.item} · 步骤 ${execution.step} · 第 ${execution.attempt} 次 · ${STATES[execution.state] ?? execution.state}`,
    );
    for (const [key, label] of Object.entries({
      role: "角色",
      thread: "thread",
      session: "会话",
      turn: "Turn",
      progress_at: "最近实际进展",
      started_at: "准入时间",
      finished_at: "结束时间",
      output: "产出",
      result: "结果",
      error: "失败原因",
      artifacts: "产物",
    })) {
      if (execution[key] !== undefined && execution[key] !== null) lines.push(`  ${label}：${words(execution[key])}`);
    }
  }
  return lines;
}
