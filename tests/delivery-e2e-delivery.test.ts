// Failure modes: a draft check authorizes a merge, fixture paths overlap another run, Ship reports a different commit,
// or a cloud workflow tries to reach the Windows-only health server instead of producing verifiable release evidence.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { deliveryFixture } from "../scripts/delivery-e2e/delivery.ts";
import { settings } from "../plugins/delivery/project.ts";

const options = { repo: "example/test", runId: "test-123", healthURL: "http://127.0.0.1:34567/health" };

test("delivery fixtures require ready checks and use a real review with run-specific files", () => {
  const fixture = deliveryFixture(options);
  const config = settings(JSON.parse(fixture.files["ops/delivery.json"]), true);
  assert.equal(config.repo, options.repo);
  assert.equal(config.review.command, undefined, "the plugin's real reviewer must not be replaced by a fixture result");
  assert.ok(fixture.files[config.review.points].includes("## 审查要点"));
  assert.equal(config.health?.url, options.healthURL);
  assert.equal(config.check.workflow, fixture.checkWorkflow);
  assert.equal(config.ship.workflow, fixture.shipWorkflow);
  const checks = fixture.files[`.github/workflows/${fixture.checkWorkflow}`];
  assert.match(checks, /ready_for_review/);
  assert.match(checks, /if: '!github.event.pull_request.draft'/);
  assert.match(checks, /  check:\n/);
  const ship = fixture.files[`.github/workflows/${fixture.shipWorkflow}`];
  assert.ok(!ship.includes("127.0.0.1"));
  assert.ok(ship.includes(fixture.shipArtifact));
  assert.match(ship, /upload-artifact@[a-f0-9]{40}/);
  assert.match(
    ship,
    /include-hidden-files: true/,
    "the explicitly named manifest is inside a hidden fixture directory",
  );
  const other = deliveryFixture({ ...options, runId: "test-456" });
  assert.notEqual(other.shipArtifact, fixture.shipArtifact);
  assert.notEqual(other.appPath, fixture.appPath);
});

test("the real Ship command checks the fixture and records its actual GitHub commit", () => {
  const root = mkdtempSync(
    join(
      process.platform === "win32" ? join(homedir(), "AppData", "Local", "Temp") : tmpdir(),
      "autoloop-delivery-fixture-",
    ),
  );
  const fixture = deliveryFixture(options);
  const sha = "a".repeat(40);
  try {
    for (const [name, contents] of Object.entries(fixture.files)) {
      const file = join(root, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, contents);
    }
    const run = (script: string) =>
      spawnSync(process.execPath, [join(root, script)], {
        cwd: root,
        env: { ...process.env, GITHUB_SHA: sha },
        encoding: "utf8",
      });
    assert.equal(run(fixture.checkPath).status, 0);
    writeFileSync(join(root, fixture.appPath), "版本二\n");
    assert.equal(run(fixture.shipPath).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(root, fixture.manifestPath), "utf8")), {
      runId: options.runId,
      commit: sha,
      version: "版本二",
      kind: "delivery-e2e-fixture",
    });
    writeFileSync(join(root, fixture.appPath), "错误版本\n");
    assert.notEqual(run(fixture.checkPath).status, 0);
    assert.notEqual(run(fixture.shipPath).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
