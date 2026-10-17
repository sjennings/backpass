import fs from "node:fs";
import path from "node:path";

import { emptyInteractionSignals, interactionSignals } from "../../interaction.js";
import {
  attachToolResults,
  contentToEvents,
  home,
  listDirs,
  listFiles,
  parseJsonLine,
  readHeadLines,
  readJsonFile,
  readJsonl,
  statOrNull,
} from "./shared.js";

/**
 * Polytoken: ~/.local/share/polytoken/sessions-v1/<session-id>/ (current) and the
 * legacy `sessions/` sibling beside it.
 *
 * Each session directory holds `session.json` (the metadata record: `project_path`
 * cwd, `created_at`, `initial_model_name`, `inferred_title`, `harness_type`,
 * `parent_session_id`) and `log.jsonl`, the full conversation transcript. Current
 * logs wrap every message in a DaemonEvent envelope (`{index, committed_at,
 * attribution, public_payload, message}`); legacy logs and the per-subagent
 * `subagent-<type>_<label>.jsonl` files write the bare message object per line, so
 * one reader unwraps `.message` when present and reads the line itself otherwise.
 * Conversation messages are `user` (`kind: "human"`; a `reiterated` user line is the
 * Goal Driver's automatic continuation prompt, and any other kind is programmatic
 * too), `assistant` (typed `blocks`: text, thinking, tool_use), and `tool_result`
 * (`results[]` keyed by `tool_use_id`). Everything else - `state_update`,
 * `system_reminder`, `subagent_spawn_v2`, `model_switch_v2`, notifications - is
 * harness bookkeeping and never reaches the distiller. `trace.jsonl` is a daemon
 * diagnostic log, not a conversation.
 *
 * No git remote is recorded anywhere, so like claude a deleted worktree can only
 * reach tier 3; a live worktree path associates at tier 1, a sibling clone sharing
 * a remote at tier 1.5.
 *
 * `POLYTOKEN_DATA_PATH` relocates the whole data directory (falling back to
 * `$XDG_DATA_HOME/polytoken`, then `~/.local/share/polytoken`), and both roots
 * under it are scanned: migrating a session to the current layout leaves the same
 * session id in both, so listing dedupes by session id with the current root first
 * - a copied session never counts twice. A run also reads each root named in the
 * personal `discovery.polytokenSessionRoots`: a sessions directory as accepted by
 * polytoken's own `--sessions-dir` flag (orchestrators such as firstmate launch
 * workers with a per-task root named this way), or a full data directory holding
 * `sessions-v1`/`sessions`. Those per-task roots are deleted when the orchestrator
 * cleans up its task, so a root that no longer exists simply reads as empty.
 *
 * Subagent transcripts are listed like omp's nested sessions: each file is its own
 * non-interactive transcript, classified against its parent session's `session.json`
 * and carrying the parent's id for corroboration. `harness_type` records what drove
 * the session - `tui` or absent is a human at the terminal, any other value (`exec`,
 * an attached client) is not.
 */

export const name = "polytoken";

const SUBAGENT_PREFIX = "subagent-";
const SUBAGENT_STARTED_AT_LINES = 10;

function dataDirs() {
  if (process.env.POLYTOKEN_DATA_PATH) return [process.env.POLYTOKEN_DATA_PATH];
  if (process.env.XDG_DATA_HOME) return [path.join(process.env.XDG_DATA_HOME, "polytoken")];
  return [home(".local", "share", "polytoken")];
}

/** The versioned and legacy registry roots inside one data directory. */
function registryRoots(dataDir) {
  return [path.join(dataDir, "sessions-v1"), path.join(dataDir, "sessions")];
}

function realpathOrResolve(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

/**
 * Every root a run lists: the relocated-or-default data directory's two registries,
 * then each configured root (a sessions directory, or a data directory when it holds
 * the registry layout). Repeated roots are read once.
 *
 * @param {{ discovery?: { polytokenSessionRoots?: string[] } } | null | undefined} config
 * @returns {string[]}
 */
export function sessionRoots(config) {
  const roots = [];
  for (const dataDir of dataDirs()) roots.push(...registryRoots(dataDir));
  for (const entry of config?.discovery?.polytokenSessionRoots || []) {
    roots.push(...(looksLikeDataDir(entry) ? registryRoots(entry) : [entry]));
  }
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    const key = realpathOrResolve(root);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

/** A configured entry holding the registry layout is a data directory, not a sessions root. */
function looksLikeDataDir(entry) {
  return registryRoots(entry).some((root) => statOrNull(root)?.isDirectory());
}

/**
 * @param {{ config?: { discovery?: { polytokenSessionRoots?: string[] } } }} [options]
 */
export function enumerate({ config } = {}) {
  const out = [];
  const seenIds = new Set();
  const seenFiles = new Set();

  const push = (file, sessionDir, sessionId, extra) => {
    const key = realpathOrResolve(file);
    if (seenFiles.has(key)) return;
    const stat = statOrNull(file);
    if (!stat) return;
    seenFiles.add(key);
    out.push({ key, path: file, mtimeMs: stat.mtimeMs, bytes: stat.size, sessionDir, sessionId, ...extra });
  };

  for (const root of sessionRoots(config)) {
    for (const dir of listDirs(root)) {
      const sessionId = path.basename(dir);
      // A session directory is named by its session id and holds session.json; the
      // current root is listed first, so its copy of a migrated session wins.
      if (seenIds.has(sessionId) || !statOrNull(path.join(dir, "session.json"))) continue;
      seenIds.add(sessionId);
      push(path.join(dir, "log.jsonl"), dir, sessionId, { subagent: false, label: null });
      for (const file of listFiles(dir, ".jsonl")) {
        const base = path.basename(file);
        if (!base.startsWith(SUBAGENT_PREFIX)) continue;
        push(file, dir, sessionId, { subagent: true, label: base.slice(0, -".jsonl".length) });
      }
    }
  }
  return out;
}

export function createScanContext() {
  return { sessionMetas: new Map() };
}

/**
 * Classification reads the session's `session.json`, not the transcript file the
 * candidate is keyed on, and that record keeps changing after the last log write
 * (an attaching client sets `harness_type`, the title is inferred late), so every
 * candidate depends on the metadata file's fingerprint.
 *
 * @param {{ scanContext?: { sessionMetas: Map<string, { meta: object, fingerprint: string } | null> } }} [options]
 */
export function cacheDependency(candidate, options = {}) {
  return readSessionMeta(candidate.sessionDir, options.scanContext)?.fingerprint ?? null;
}

function readSessionMeta(sessionDir, scanContext) {
  const cache = scanContext?.sessionMetas;
  if (cache?.has(sessionDir)) return cache.get(sessionDir);
  const file = path.join(sessionDir, "session.json");
  const stat = statOrNull(file);
  const meta = stat?.isFile() ? readJsonFile(file) : null;
  const result =
    meta && typeof meta === "object"
      ? {
          meta,
          fingerprint: JSON.stringify([
            stat.dev,
            stat.ino,
            stat.mtimeMs,
            stat.ctimeMs,
            stat.size,
            meta.session_id ?? null,
            meta.project_path ?? null,
            meta.harness_type ?? null,
          ]),
        }
      : null;
  cache?.set(sessionDir, result);
  return result;
}

/** The earliest timestamp a subagent file records for itself, before any real work. */
function subagentStartedAt(candidate) {
  for (const line of readHeadLines(candidate.path, SUBAGENT_STARTED_AT_LINES)) {
    const entry = parseJsonLine(line);
    const emitted = entry?.message?.emitted_at ?? entry?.emitted_at;
    const parsed = emitted ? Date.parse(emitted) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return candidate.mtimeMs;
}

/**
 * @param {{ scanContext?: { sessionMetas: Map<string, { meta: object, fingerprint: string } | null> } }} [options]
 */
export function classify(candidate, options = {}) {
  const meta = readSessionMeta(candidate.sessionDir, options.scanContext)?.meta;
  if (!meta || typeof meta.project_path !== "string" || !meta.project_path) return null;

  const id = meta.session_id || candidate.sessionId;
  const created = meta.created_at ? Date.parse(meta.created_at) : NaN;
  const startedAt = Number.isFinite(created) ? created : candidate.mtimeMs;
  const descriptor = {
    id,
    cwd: meta.project_path,
    gitBranch: null,
    remotes: [],
    startedAt,
    model: typeof meta.initial_model_name === "string" && meta.initial_model_name ? meta.initial_model_name : null,
    title: typeof meta.inferred_title === "string" && meta.inferred_title ? meta.inferred_title : null,
    interactionSignals: meta.harness_type
      ? interactionSignals({ entrypoint: String(meta.harness_type) })
      : emptyInteractionSignals(),
  };

  if (candidate.subagent) {
    descriptor.id = `${id}/${candidate.label}`;
    descriptor.startedAt = subagentStartedAt(candidate);
    descriptor.interactionSignals = { source: "subagent" };
    descriptor.parentSessionId = id;
    descriptor.parentSessionPath = path.join(candidate.sessionDir, "log.jsonl");
    descriptor.parentSessionStartedAt = startedAt;
  }
  return descriptor;
}

export function read(ref) {
  const entries = readJsonl(ref.path);
  const events = [];
  let model = null;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    // Current logs wrap the message in a DaemonEvent envelope; legacy logs and
    // subagent files write the bare message per line.
    const message = entry.message ?? entry;
    if (!message || typeof message !== "object") continue;

    switch (message.type) {
      case "user": {
        // `human` (or no kind yet, on legacy logs) is a person; `reiterated` is the
        // Goal Driver's automatic continuation prompt, and any other kind is
        // programmatic input.
        if (message.kind && message.kind !== "human") continue;
        contentToEvents("user", message.content, events);
        break;
      }
      case "assistant": {
        if (!model && typeof entry.attribution?.model === "string") model = entry.attribution.model;
        contentToEvents("assistant", message.blocks ?? message.content, events);
        break;
      }
      case "tool_result": {
        for (const result of message.results || []) {
          if (!result || typeof result !== "object") continue;
          events.push({
            kind: "tool-result",
            id: result.tool_use_id ?? result.id,
            result: resultText(result.content ?? result.output ?? result.text),
            status: result.is_error ? "error" : "completed",
          });
        }
        break;
      }
      default:
        // state_update, system_reminder, subagent_spawn/complete, model switches,
        // notifications, session lifecycle: harness bookkeeping, not conversation.
        break;
    }
  }

  return { events: attachToolResults(events), model };
}

/** A tool result's content is a string, a `{text}` block, or a list of either. */
function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : (block?.text ?? "")))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && typeof content.text === "string") return content.text;
  return content;
}
