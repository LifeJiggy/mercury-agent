import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { BOT_SHARED_SANDBOX_DIRNAME } from './store.js';

/**
 * Sandbox retention janitor (two-stage: cool down → expire).
 *
 * The fleet-shared folder accumulates inter-run signal — dated status
 * reports, sweep results, handoffs. It is a message surface, not storage:
 * anything that must survive is the main journal's or a deliverable's job
 * (see `BotManager.deliver` / `outputsDir`, which this janitor never
 * touches). Files cool down in place for `hotDays`, then move to
 * `_shared/.archive/<yyyy-mm>/` (bots no longer need them in the working
 * surface, but recovery is possible), then are hard-deleted after
 * `archiveDays` in the archive.
 *
 * Safety rails:
 *  - never touches anything modified in the last 24h (clock skew, in-flight
 *    turns),
 *  - never touches dotfiles (metadata like .DS_Store) or anything other
 *    than top-level REGULAR FILES of the shared folder,
 *  - idempotent: re-running on the same state moves/deletes nothing more,
 *  - every action journaled by the caller via the returned summary.
 */

/** Never touch anything younger than this, regardless of thresholds. */
const SAFE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export interface SandboxJanitorOptions {
  /** Files leave the working surface after this many days (default 7). */
  hotDays?: number;
  /** Archived files are deleted after this many days (default 30). */
  archiveDays?: number;
  /** Millisecond epoch for the sweep — injectable for deterministic tests. */
  now?: number;
}

export interface JanitorAction {
  /** Path relative to the bots root (never absolute — logs stay portable). */
  file: string;
  ageDays: number;
}

export interface SandboxJanitorResult {
  moved: Array<JanitorAction & { archivedTo: string }>;
  deleted: JanitorAction[];
  /** Files seen and deliberately kept (recent, or below threshold). */
  kept: number;
  errors: string[];
}

export function sweepSharedSandbox(botsRoot: string, opts: { hotDays?: number; archiveDays?: number; now?: number } = {}): SandboxJanitorResult {
  const result: SandboxJanitorResult = { moved: [], deleted: [], kept: 0, errors: [] };
  const now = opts.now ?? Date.now();
  const hotMs = (opts.hotDays ?? 7) * 24 * 60 * 60 * 1000;
  const archiveMs = (opts.archiveDays ?? 30) * 24 * 60 * 60 * 1000;

  const shared = join(botsRoot, BOT_SHARED_SANDBOX_DIRNAME);
  if (!existsSync(shared)) return result;

  // Stage 1: cool down — top-level regular files past their hot window move
  // into the month-stamped archive (mtime is what ages them; rename keeps it).
  const archiveRoot = join(shared, '.archive');
  let entries: string[];
  try {
    entries = readdirSync(shared);
  } catch (err: any) {
    result.errors.push(`readdir ${BOT_SHARED_SANDBOX_DIRNAME}: ${err?.message}`);
    return result;
  }

  for (const name of entries) {
    if (name.startsWith('.')) continue; // dotfiles (incl. .DS_Store, .archive) are never swept
    const file = join(shared, name);
    try {
      const stat = statSync(file);
      if (!stat.isFile()) continue;
      const ageMs = now - stat.mtimeMs;
      if (ageMs < SAFE_MIN_AGE_MS) {
        result.kept += 1;
        continue;
      }
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      if (ageMs < hotMs) {
        result.kept += 1;
        continue;
      }
      const month = new Date(now).toISOString().slice(0, 7);
      const destDir = join(archiveRoot, month);
      mkdirSync(destDir, { recursive: true });
      const archivedTo = uniquePath(join(destDir, name));
      renameSync(file, archivedTo);
      result.moved.push({ file: name, ageDays, archivedTo: archivedTo });
    } catch (err: any) {
      if (err?.code === 'EBUSY' || err?.code === 'EPERM') {
        result.kept += 1; // in use right now — a later sweep takes it
        continue;
      }
      result.errors.push(`${name}: ${err?.message}`);
    }
  }

  // Stage 2: expire — archived files past the archive window are deleted.
  if (!existsSync(archiveRoot)) return result;
  let archived: string[];
  try {
    archived = readdirSync(archiveRoot);
  } catch (err: any) {
    result.errors.push(`readdir .archive: ${err?.message}`);
    return result;
  }
  for (const month of archived) {
    const monthDir = join(archiveRoot, month);
    let files: string[];
    try {
      files = readdirSync(monthDir);
    } catch (err: any) {
      result.errors.push(`readdir .archive/${month}: ${err?.message}`);
      continue;
    }
    for (const name of files) {
      const filePath = join(monthDir, name);
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;
        const ageMs = now - stat.mtimeMs;
        if (ageMs < SAFE_MIN_AGE_MS || ageMs < archiveMs) continue;
        unlinkSync(filePath);
        result.deleted.push({ file: `${month}/${name}`, ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)) });
      } catch (err: any) {
        if (err?.code === 'EBUSY' || err?.code === 'EPERM') continue;
        result.errors.push(`.archive/${month}/${name}: ${err?.message}`);
      }
    }
    // Leave empty month dirs behind — harmless, and deleting them would race
    // a concurrent sweep on another manager instance.
  }

  return result;
}

/** First free path for an archive move — never overwrites an existing entry. */
function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  for (let i = 2; ; i++) {
    const candidate = path.replace(/(\.[^./\\]+)?$/, `-${i}$1`);
    if (!existsSync(candidate)) return candidate;
  }
}