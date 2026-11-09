import assert from "node:assert/strict";
import type { Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export async function waitForPolls<T extends { active: number }>(
  sample: (signal: AbortSignal) => Promise<T>,
  active: number,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) throw new DOMException("长轮询未在期限内到齐", "TimeoutError");
  const signal = AbortSignal.timeout(Math.ceil(timeoutMs));
  for (;;) {
    signal.throwIfAborted();
    const seen = await sample(signal);
    signal.throwIfAborted();
    if (seen.active === active) return seen;
    await delay(10);
  }
}

// Attach the rejection handler before starting the next batch; otherwise Node exits before cleanup.
export const observe = <T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> =>
  promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );

export function observePolls(server: Server) {
  const count = { active: 0, peak: 0 };
  server.prependListener("request", (req, res) => {
    if (!/^\/v1\/work\?wait=50?&/.test(req.url ?? "")) return;
    count.peak = Math.max(count.peak, ++count.active);
    res.once("close", () => count.active--);
  });
  return count;
}

export async function dispatchLatency(
  request: (path: string, key: string, body?: unknown) => Promise<any>,
  ready: () => Promise<void>,
  id: number,
) {
  const pending = observe(request(`/v1/work?wait=5&claim=claim${id}`, "worker"));
  await ready();
  const at = performance.now();
  await request("/v1/events", "source", { id: `claim:${id}`, type: "feedback.new", subject: `#${id}` });
  const result = await pending;
  if (result.status === "rejected") throw result.reason;
  assert.ok(result.value.job);
  return { job: result.value.job, ms: performance.now() - at };
}

/** The value this share of the samples stays at or under; with too few samples, the nearest one above it. */
export function percentile(values: number[], share: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)];
}

/** Runs an action up to count times, or until it has used its time, and how long each took. Never fewer than once. */
export async function timed(count: number, budgetMs: number, action: (index: number) => Promise<unknown>) {
  const took: number[] = [];
  const start = performance.now();
  while (took.length < count && (!took.length || performance.now() - start < budgetMs)) {
    const at = performance.now();
    await action(took.length);
    took.push(performance.now() - at);
  }
  return took;
}

export function checkPolls(count: { active: number; peak: number }, completed: number) {
  assert.equal(count.active, 1000, "必须同时有 1000 个长轮询正在等待");
  assert.equal(completed, 1000, "必须有 1000 个成功响应");
}
