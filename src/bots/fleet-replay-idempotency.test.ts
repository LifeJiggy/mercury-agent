import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotStore, BotStore as Store } from './store.js';
import { BotManager } from './bot-manager.js';
import { getDefaultConfig, type MercuryConfig } from '../utils/config.js';

// Mock only generateText — no LLM work (fleet build / replay paths).
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn() };
});

// Windows EBUSY guard: every BotManager owns an open SQLite queue handle;
// afterEach disposes all of them before the tmpdir is deleted.
const activeManagers: Array<{ dispose: () => void }> = [];

function makeManager(root: string): BotManager {
  const config = getDefaultConfig() as MercuryConfig;
  config.bots.maxConcurrent = 4;
  const manager = new BotManager({
    config,
    providers: {
      get: () => undefined,
      getDefault: () => ({
        name: 'stub', model: 'stub-model',
        generateText: async () => ({ text: 'ok', inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'stub-model', provider: 'stub' }),
        streamText: async function* () { yield { text: 'ok', done: true }; },
        isAvailable: () => true, getModelInstance: () => ({}), getModel: () => 'stub-model',
      } as any),
    } as any,
    tokenBudget: { recordUsage: () => {}, getRemaining: () => 100000, getStatusText: () => '', getUsagePercentage: () => 0 } as any,
    store: new BotStore(join(root, 'bots')),
    userMemoryFactory: () => null,
  });
  activeManagers.push(manager);
  return manager;
}

const FULL_FLEET = ['research', 'writer', 'editor', 'scout', 'packager', 'checker'];

function buildFleet(manager: BotManager): void {
  const store = manager['store'];
  store.create({ id: 'ceo', name: 'CEO', description: 'lead', manifest: { fleetRole: 'lead' } });
  for (const id of FULL_FLEET) {
    const r = manager.addCrew('ceo', { id, name: id, description: id, persona: 'x'.repeat(40) });
    if (!r.ok) throw new Error(r.error);
  }
}

describe('fleet replay-safety — a rebuilt crew never grows the roster', () => {
  let root: string;
  let manager: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-fleet-replay-'));
    manager = makeManager(root);
  });

  afterEach(() => {
    for (const m of activeManagers.splice(0)) m.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('re-running the crew build with the SAME ids is a no-op (duplicate:true)', () => {
    buildFleet(manager);
    expect(manager.getStatusSummaries()).toHaveLength(7);
    for (const id of FULL_FLEET) {
      const r = manager.addCrew('ceo', { id, name: id, description: id, persona: 'y'.repeat(40) });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.duplicate).toBe(true);
    }
    expect(manager.getStatusSummaries()).toHaveLength(7);
  });

  it('a replayed build that RE-DERIVES ids (same names) creates nothing', () => {
    buildFleet(manager);
    // The LLM invents fresh ids for the same specialties — historically this
    // passed the id-only guard and duplicated the fleet per replay.
    const derivedIds = ['curator', 'drafts', 'polish', 'watcher', 'shipper', 'auditor'];
    derivedIds.forEach((id, i) => {
      const r = manager.addCrew('ceo', { id, name: FULL_FLEET[i], description: id, persona: 'z'.repeat(40) });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.duplicate).toBe(true);
    });
    const roster = manager.getStatusSummaries();
    expect(roster).toHaveLength(7);
    expect(execBotYamlCount(root)).toBe(7);
  });

  it('the name match is scoped to the lead — same name under another lead is allowed', () => {
    const store = manager['store'];
    store.create({ id: 'ceo', name: 'CEO', description: 'lead', manifest: { fleetRole: 'lead' } });
    store.create({ id: 'cto', name: 'CTO', description: 'lead 2', manifest: { fleetRole: 'lead' } });
    const r1 = manager.addCrew('ceo', { id: 'research', name: 'Research', description: '', persona: 'q'.repeat(40) });
    expect(r1.ok).toBe(true);
    // Same display name under a DIFFERENT lead is a legitimate new member.
    const r2 = manager.addCrew('cto', { id: 'research-2', name: 'Research', description: '', persona: 'q'.repeat(40) });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.duplicate).toBeUndefined();
    expect(manager.getStatusSummaries()).toHaveLength(4);
  });

  it('an id belonging to another lead stays an error (never re-parents implicitly)', () => {
    buildFleet(manager);
    const store = manager['store'];
    store.create({ id: 'other-lead', name: 'Other Lead', manifest: { fleetRole: 'lead' } });
    const r = manager.addCrew('other-lead', { id: 'research', name: 'Different Name Anyway', description: '', persona: 'q'.repeat(40) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already exists/);
  });

  it('case differences in spec name do not defeat the dedupe', () => {
    buildFleet(manager); // crew names are the ids, e.g. "research"
    const r = manager.addCrew('ceo', { id: 'fresh-id', name: '  RESEARCH ', description: '', persona: 'q'.repeat(40) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.duplicate).toBe(true);
    expect(manager.getStatusSummaries()).toHaveLength(7);
  });
});

describe('reopen sequence (single runtime) — fleet stays intact', () => {
  let root: string;
  let manager1: BotManager;
  let manager2: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-reopen-dup-'));
  });

  afterEach(() => {
    for (const m of activeManagers.splice(0)) m.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('session 1 builds 7; session 2 (migrations + 50 roster polls) keeps 7', async () => {
    manager1 = makeManager(root);
    buildFleet(manager1);
    expect(manager1.getStatusSummaries().length).toBe(7);
    manager1.dispose();

    manager2 = makeManager(root);
    await manager2.migrateFleetLayout();
    await manager2.migratePermissions();
    for (let i = 0; i < 50; i++) manager2.getStatusSummaries();

    const roster = manager2.getStatusSummaries().map(s => s.id).sort();
    expect(roster.length).toBe(7);
    expect(new Set(roster).size).toBe(7);
    expect(execBotYamlCount(root)).toBe(7);
  });

  it('a durable job from a crashed mid-crew-build session replays WITHOUT duplicating crew', async () => {
    manager1 = makeManager(root);
    buildFleet(manager1);
    // Simulate the interrupted turn that built the crew: its durable job was
    // claimed, never settled, and the process died (app closed mid-turn).
    const job = manager1.enqueue('ceo', { trigger: 'chat', prompt: 'hire your crew' });
    expect(job.accepted).toBe(true);
    manager1.dispose();

    const manager2 = makeManager(root);
    await manager2.migrateFleetLayout();
    const roster = manager2.getStatusSummaries();
    expect(roster.length).toBe(7);
    expect(new Set(roster.map(s => s.id)).size).toBe(7);
    manager2.dispose();
  });
});

describe('store.list() roster dedupe — a forked physical copy is shown once', () => {
  let root: string;
  let store: BotStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-fleet-list-dedupe-'));
    store = new BotStore(join(root, 'bots'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a bot profile existing both at the root and nested under its lead renders once', () => {
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    store.create({ id: 'qa', name: 'QA', manifest: { fleetRole: 'crew', parent: 'ceo' } });
    // Simulate the historical fork: a stale FLAT copy left behind when a
    // relocation raced another runtime / failed on Windows-locked dirs.
    // (Same directory NAME in two places — only that shape double-counted.)
    const flatCopy = join(root, 'bots', 'qa');
    mkdirSync(flatCopy, { recursive: true });
    writeFileSync(join(flatCopy, 'bot.yaml'), 'id: qa\nname: QA\n', 'utf-8');

    const ids = store.list().map(m => m.id);
    expect(ids.filter(x => x === 'ceo')).toHaveLength(1);
    expect(ids.filter(x => x === 'qa')).toHaveLength(1);
  });
});

function execBotYamlCount(root: string): number {
  let count = 0;
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'bot.yaml') count += 1;
      else if (entry.isDirectory()) visit(join(dir, entry.name));
    }
  };
  visit(join(root, 'bots'));
  return count;
}