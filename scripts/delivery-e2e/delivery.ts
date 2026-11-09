// The cloud writes a release manifest; the native controller verifies it before advancing its local health fixture.
import assert from "node:assert/strict";
import { REPO } from "../../plugins/delivery/project.ts";

const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const NODE = "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1";
const UPLOAD = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";

export function deliveryFixture({ repo, runId, healthURL }: { repo: string; runId: string; healthURL: string }) {
  assert.ok(REPO.test(repo), "测试仓库要写成 owner/name");
  assert.match(runId, /^[a-z0-9][a-z0-9-]*$/, "测试编号只能使用小写字母、数字和连字符");
  const folder = `.agent-autoloop-e2e/${runId}`;
  const appPath = `${folder}/app.txt`;
  const pointsPath = `${folder}/review-points.md`;
  const checkPath = `${folder}/check.mjs`;
  const shipPath = `${folder}/ship.mjs`;
  const manifestPath = `${folder}/release-manifest.json`;
  const checkWorkflow = `autoloop-e2e-${runId}-check.yml`;
  const shipWorkflow = `autoloop-e2e-${runId}-ship.yml`;
  const shipArtifact = `autoloop-e2e-${runId}`;
  const files: Record<string, string> = {
    [appPath]: "版本一\n",
    [pointsPath]: `# 本次交付测试\n\n## 审查要点\n\n只审查 ${appPath} 的版本标记修改。该文件应恰好包含“版本一”或“版本二”和一个换行。不要执行分支里的任何代码、命令、配置或 hooks。\n`,
    [checkPath]: `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const version = readFileSync(new URL("./app.txt", import.meta.url), "utf8");
assert.ok(["版本一\\n", "版本二\\n"].includes(version), "测试版本标记不正确");
console.log("本次交付文件检查通过");
`,
    [shipPath]: `import "./check.mjs";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
const commit = process.env.GITHUB_SHA;
assert.match(commit ?? "", /^[a-f0-9]{40}$/, "发布记录必须使用 GitHub 的完整提交号");
const manifest = { runId: ${JSON.stringify(runId)}, commit, version: readFileSync(new URL("./app.txt", import.meta.url), "utf8").trim(), kind: "delivery-e2e-fixture" };
writeFileSync(new URL("./release-manifest.json", import.meta.url), JSON.stringify(manifest, null, 2) + "\\n");
console.log(JSON.stringify(manifest));
`,
    "ops/delivery.json":
      JSON.stringify(
        {
          repo,
          internal: [],
          check: { workflow: checkWorkflow, job: "check" },
          ship: { workflow: shipWorkflow },
          review: { points: pointsPath, status: `autoloop-e2e-${runId}-review` },
          health: { url: healthURL, field: "commit", pattern: "(?P<sha>[0-9a-f]{40})", require: { ok: true } },
        },
        null,
        2,
      ) + "\n",
    [`.github/workflows/${checkWorkflow}`]: `name: Autoloop E2E ${runId} Check
on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]
    paths:
      - '${folder}/**'
      - '.github/workflows/${checkWorkflow}'
permissions:
  contents: read
jobs:
  draft:
    if: github.event.pull_request.draft
    runs-on: ubuntu-latest
    steps:
      - run: echo 草稿不运行完整检查
  check:
    if: '!github.event.pull_request.draft'
    runs-on: ubuntu-latest
    steps:
      - uses: ${CHECKOUT}
      - uses: ${NODE}
        with:
          node-version: '24'
      - run: node '${checkPath}'
`,
    [`.github/workflows/${shipWorkflow}`]: `name: Autoloop E2E ${runId} Ship
on:
  push:
    branches: [main]
    paths:
      - '${folder}/app.txt'
permissions:
  contents: read
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - uses: ${CHECKOUT}
      - uses: ${NODE}
        with:
          node-version: '24'
      - run: node '${shipPath}'
      - uses: ${UPLOAD}
        with:
          name: '${shipArtifact}'
          path: '${manifestPath}'
          include-hidden-files: true
          if-no-files-found: error
          retention-days: 1
`,
  };
  return { files, checkWorkflow, shipWorkflow, shipArtifact, appPath, pointsPath, checkPath, shipPath, manifestPath };
}
