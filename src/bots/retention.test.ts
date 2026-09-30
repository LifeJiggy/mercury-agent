import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepSharedSandbox } from './retention.js';
import { BOT_SHARED_SANDBOX_DIRNAME, BotStore } from './store.js';

const NOW = new Date('2026-09-30T12:00:00Z').getTime();
const DAYS = 24 * 60 * 60 * 1000;

function makeFleetRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mercury-retention-'));
  new BotStore(join(root, 'bots')); // materializes the bots root layout
  const shared = join(root, 'bots', BOT_SHARED_SANDBOX_DIRNAME);
  mkdirSync(shared, { recursive: true });
  return root;
}

function seed(root: string, name: string, ageDays: number): string {
  const file = join(root, 'bots', BOT_SHARED_SANDBOX_DIRNAME, name);
  writeFileSync(file, `payload ${name}`);
  const mtime = new Date(NOW - ageDays * DAYS); // fs.utimes accepts Date — a bare number is SECONDS
  utimesSync(file, mtime, mtime);
  return file;
}

describe('shared-sandbox retention janitor', () => {
  it('cools down files past the hot window into the month-stamped archive', () => {
    const root = makeFleetRoot();
    seed(root, 'old-report.md', 12); // 12 days old — past the 7-day hot window
    const result = sweepSharedSandbox(join(root, 'bots'), { hotDays: 7, archiveDays: 30, now: NOW });
    expect(result.moved.map((m) => m.file)).toContain('old-report.md');
    expect(result.moved[0].ageDays).toBe(12);
    expect(existsSync(join(root, 'bots', BOT_SHARED_SANDBOX_DIRNAME, 'old-report.md'))).toBe(false);
    expect(existsSync(join(root, 'bots', BOT_SHARED_SANDBOX_DIRNAME, '.archive', '2026-09', 'old-report.md'))).toBe(true);
  });

  it('keeps recent files in the working surface', () => {
    const root = makeFleetRoot();
    seed(root, 'fresh-dashboard.md', 1); // inside BOTH the 24h safety net and the hot window
    seed(root, 'three-days-old.md', 3); // inside neither
    const result = sweepSharedSandbox(join(root, 'bots'), { hotDays: 7, archiveDays: 30, now: NOW });
    expect(result.moved).toHaveLength(0);
    expect(existsSync(join(root, 'bots', BOT_SHARED_SANDBOX_DIRNAME, 'fresh-dashboard.md'))).toBe(true);
    expect(existsSync(join(root, 'bots', BOT_SHARED_SANDBOX_DIRNAME, 'three-days-old.md'))).toBe(true);
  });

  it('never sweeps younger than 24h even with an aggressive hot window', () => {
    const root = makeFleetRoot();
    seed(root, 'hours-old.md', 0.5);
    const result = sweepSharedSandbox(root, { hotDays: 0.1, archiveDays: 30, now: NOW });
    expect(result.moved).toHaveLength(0);
  });

  it('expires archived files past the archive window', () => {
    const root = makeFleetRoot();
    seed(root, 'ancient-sweep.md', 12); // moved to archive (12 > 7 hot days)
    sweepSharedSandbox(join(root, 'bots'), { hotDays: 7, archiveDays: 30, now: NOW });
    const archived = join(root, 'bots', BOT_SHARED_SANDBOX_DIRNAME, '.archive', '2026-09', 'ancient-sweep.md');
    expect(existsSync(archived)).toBe(true);
    // Backdate the ARCHIVE copy by 45 days — past the 30-day archive window
    const archiveMtime = new Date(NOW - 31 * DAYS);
    utimesSync(archived, archiveMtime, archiveMtime);
    const result = sweepSharedSandbox(join(root, 'bots'), { hotDays: 7, archiveDays: 30, now: NOW });
    expect(result.deleted.map((d) => d.file)).toContain('2026-09/ancient-sweep.md');
    expect(existsSync(archived)).toBe(false);
  });

  it('is idempotent and never overwrites an archived name on re-run', () => {
    const root = makeFleetRoot();
    seed(root, 'superseded.md', 10);
    sweepSharedSandbox(join(root, 'bots'), { hotDays: 7, archiveDays: 30, now: NOW });
    // Same filename appears again and ages out while its archived twin exists
    seed(root, 'superseded.md', 10);
    const result = sweepSharedSandbox(join(root, 'bots'), { hotDays: 7, archiveDays: 30, now: NOW });
    expect(result.moved).toHaveLength(1);
    expect(result.moved[0].archivedTo).toContain('superseded-2.md');
  });

  it('never sweeps reference files younger than the hot window when another bot still reads them', () => {
    const root = makeFleetRoot();
    seed(root, 'account-personas-roster-2026-09-24.md', 6); // 6 days old, < 7
    const result = sweepSharedSandbox(join(root, 'bots'), { hotDays: 7, archiveDays: 30, now: NOW });
    expect(result.moved).toHaveLength(0);
    expect(existsSync(join(root, 'bots', BOT_SHARED_SANDBOX_DIRNAME, 'account-personas-roster-2026-09-24.md'))).toBe(true);
  });

  it('leaves dotfiles, directories and non-shared trees untouched', () => {
    const root = makeFleetRoot();
    const shared = join(root, 'bots', BOT_SHARED_SANDBOX_DIRNAME);
    writeFileSync(join(shared, '.DS_Store'), 'junk');
    writeFileSync(join(shared, '.env'), 'SECRET=1');
    mkdirSync(join(shared, 'subfolder'));
    writeFileSync(join(shared, 'subfolder', 'nested.md'), 'x');
    const privateSandbox = join(root, 'bots', 'researcher');
    mkdirSync(privateSandbox, { recursive: true });
    writeFileSync(join(privateSandbox, 'private-artifact.md'), 'x');
    for (const f of ['.DS_Store', join('subfolder', 'nested.md'), join('..', 'researcher', 'private-artifact.md')]) {
      const p = join(shared, f);
      const mtime = NOW - 20 * DAYS;
      utimesSync(join(shared, f), mtime, mtime);
    }
    utimesSync(join(privateSandbox, 'private-artifact.md'), NOW - 20 * DAYS, NOW - 20 * DAYS);
    const result = sweepSharedSandbox(join(root, 'bots'), { hotDays: 7, archiveDays: 30, now: NOW });
    expect(result.moved).toHaveLength(0);
    expect(existsSync(join(shared, '.DS_Store'))).toBe(true);
    expect(existsSync(join(shared, 'subfolder', 'nested.md'))).toBe(true);
    expect(existsSync(join(privateSandbox, 'private-artifact.md'))).toBe(true);
  });

  it('sweeps the real shared folder path of a live fleet', () => {
    const root = makeFleetRoot();
    expect(readdirSync(join(root, 'bots', BOT_SHARED_SANDBOX_DIRNAME)).length).toBe(0);
    seed(root, 'agentbeat-refused-void-slot-1400-2026-09-22.md', 9);
    seed(root, 'account-health-dashboard-2026-09-30-resume.md', 0);
    const result = sweepSharedSandbox(join(root, 'bots'), { hotDays: 7, archiveDays: 30, now: NOW });
    expect(result.moved.map((m) => m.file)).toEqual(['agentbeat-refused-void-slot-1400-2026-09-22.md']);
    expect(existsSync(join(root, 'bots', BOT_SHARED_SANDBOX_DIRNAME, 'account-health-dashboard-2026-09-30-resume.md'))).toBe(true);
  });
});