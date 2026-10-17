import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { discoverTranscripts, readTranscript } from "../src/discovery/index.js";
import { setLoggerSink } from "../src/logger.js";

/**
 * `discovery.polytokenSessionRoots`: more Polytoken session roots to read beside the
 * default store, named in personal config (or for one run through overrides). Roots are
 * what polytoken's own `--sessions-dir` flag accepts - an orchestrator's per-task
 * sessions directory - or a full data directory holding `sessions-v1`/`sessions`.
 */

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");

function withEnv(env, fn) {
  const saved = {};
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "POLYTOKEN_DATA_PATH"]) {
    saved[key] = process.env[key];
  }
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-polytoken-xdg-"));
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-polytoken-home-"));
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.HOME = dataHome;
  delete process.env.XDG_DATA_HOME;
  delete process.env.POLYTOKEN_DATA_PATH;
  try {
    return fn(env);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(configHome, { recursive: true, force: true });
    fs.rmSync(dataHome, { recursive: true, force: true });
  }
}

function tempRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-polytoken-repo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync(root);
}

/** @param {{ cwd?: string }} [overrides] */
function writeSession(root, sessionId, overrides = {}) {
  const dir = path.join(root, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(FIXTURES, "polytoken-session"), dir, { recursive: true });
  const metaFile = path.join(dir, "session.json");
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  meta.session_id = sessionId;
  if (overrides.cwd) meta.project_path = overrides.cwd;
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  return dir;
}

async function captureWarnings(fn) {
  const lines = [];
  setLoggerSink((line) => lines.push(line));
  try {
    return { result: await fn(), lines };
  } finally {
    setLoggerSink(null);
  }
}

test("polytoken is an accepted harness name and on by default", () => {
  withEnv({}, () => {
    const lines = [];
    setLoggerSink((line) => lines.push(line));
    try {
      const config = loadConfig(tempRepoNoCleanup(), { discovery: { harnesses: ["polytoken"] } });
      assert.deepEqual(config.discovery.harnesses, ["polytoken"]);
      assert.deepEqual(loadConfig(tempRepoNoCleanup()).discovery.harnesses.slice(-1), ["polytoken"]);
    } finally {
      setLoggerSink(null);
    }
    assert.deepEqual(lines, [], "no unknown-harness warning");
  });
});

function tempRepoNoCleanup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-polytoken-repo-"));
  fs.rmSync(root, { recursive: true, force: true });
  return root;
}

test("polytokenSessionRoots must be absolute paths in personal config", () => {
  withEnv({}, () => {
    assert.throws(
      () => loadConfig(tempRepoNoCleanup(), { discovery: { polytokenSessionRoots: "not-a-list" } }),
      /polytokenSessionRoots must be an array of paths/,
    );
    assert.throws(
      () => loadConfig(tempRepoNoCleanup(), { discovery: { polytokenSessionRoots: ["sessions/task"] } }),
      /** @param {any} error */
      (error) => {
        assert.match(error.message, /is not an absolute path/);
        assert.match(error.hint, /not a repository path/);
        return true;
      },
    );
    const resolved = loadConfig(tempRepoNoCleanup(), {
      discovery: { polytokenSessionRoots: [`${os.tmpdir()}/polytoken-tasks`] },
    });
    assert.deepEqual(resolved.discovery.polytokenSessionRoots, [path.resolve(os.tmpdir(), "polytoken-tasks")]);
  });
});

test("a repository file may not name polytoken session roots", () => {
  withEnv({}, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-polytoken-repo-"));
    fs.writeFileSync(
      path.join(root, ".backpassrc.json"),
      JSON.stringify({ discovery: { polytokenSessionRoots: ["/tmp/elsewhere"] } }),
    );
    try {
      assert.throws(
        () => loadConfig(root),
        /** @param {any} error */
        (error) => {
          assert.match(error.message, /sets discovery\.polytokenSessionRoots/);
          assert.match(error.message, /personal configuration/);
          assert.match(error.hint, /backpass[/\\]config\.json/);
          return true;
        },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test("discovery reads a configured per-task root and associates it with the repo", async (t) => {
  const repoRoot = tempRepo(t);
  const taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-polytoken-task-"));
  t.after(() => fs.rmSync(taskRoot, { recursive: true, force: true }));
  writeSession(taskRoot, "0demo04-worker", { cwd: repoRoot });

  await withEnv({}, async () => {
    const config = loadConfig(repoRoot, {
      discovery: { harnesses: ["polytoken"], polytokenSessionRoots: [taskRoot], since: "all" },
    });
    config.state = {
      root: path.join(repoRoot, ".backpass"),
      readScanCache: () => ({ version: 1, entries: {} }),
      writeScanCache: () => {},
    };
    const repo = { name: path.basename(repoRoot), root: repoRoot, worktrees: [repoRoot], remotes: [] };
    const { result } = await captureWarnings(() => discoverTranscripts({ repo, config }));

    assert.deepEqual(result.transcripts.map((transcript) => transcript.nativeId).sort(), [
      "0demo04-worker",
      "0demo04-worker/subagent-general-purpose_demo-scan",
    ]);
    assert.ok(result.transcripts.every((transcript) => transcript.association.tier === 1));
    assert.equal(result.perHarness.polytoken.matched, 2);

    const main = result.transcripts.find((transcript) => transcript.nativeId === "0demo04-worker");
    assert.equal(main.interaction, "interactive");
    const { events } = await readTranscript(main);
    assert.ok(events.some((event) => event.kind === "message" && event.text === "Open a PR for the parser fix."));

    const subagent = result.transcripts.find(
      (transcript) => transcript.nativeId === "0demo04-worker/subagent-general-purpose_demo-scan",
    );
    assert.equal(subagent.interaction, "non-interactive");
    assert.equal(subagent.parentSessionId, "0demo04-worker");
  });
});

test("a configured root that no longer exists reads as empty", async (t) => {
  const repoRoot = tempRepo(t);
  await withEnv({}, async () => {
    const config = loadConfig(repoRoot, {
      discovery: {
        harnesses: ["polytoken"],
        polytokenSessionRoots: [path.join(os.tmpdir(), "backpass-polytoken-gone")],
        since: "all",
      },
    });
    config.state = {
      root: path.join(repoRoot, ".backpass"),
      readScanCache: () => ({ version: 1, entries: {} }),
      writeScanCache: () => {},
    };
    const repo = { name: path.basename(repoRoot), root: repoRoot, worktrees: [repoRoot], remotes: [] };
    const { result } = await captureWarnings(() => discoverTranscripts({ repo, config }));
    assert.equal(result.perHarness.polytoken.matched, 0);
  });
});
