import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock only generateText; tool()/zodSchema/stepCountIs stay real.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn() };
});

import { generateText } from 'ai';
import { BotManager } from './bot-manager.js';
import { BotStore } from './store.js';
import { getDefaultConfig, type MercuryConfig } from '../utils/config.js';

const mockedGenerateText = vi.mocked(generateText);

function makeManager(root: string): BotManager {
  const config = getDefaultConfig() as MercuryConfig;
  config.bots.maxConcurrent = 4;
  return new BotManager({
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
}

beforeEach(() => {
  mockedGenerateText.mockReset();
});

describe('fleet stop/start cascade', () => {
  let root: string;
  let manager: BotManager;
  let store: BotStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-fleet-stop-'));
    manager = makeManager(root);
    store = manager['store'];
    // CEO → eng (mid-level lead) → backend; CEO → qa.
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    store.create({ id: 'eng', name: 'Eng', manifest: { fleetRole: 'lead', parent: 'ceo' } });
    store.create({ id: 'backend', name: 'Backend', manifest: { fleetRole: 'crew', parent: 'eng' } });
    store.create({ id: 'qa', name: 'QA', manifest: { fleetRole: 'crew', parent: 'ceo' } });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('stopping the lead halts running crew and holds their queues, recursively', async () => {
    let released: (() => void) | null = null;
    const gate = new Promise<void>(r => { released = r; });
    mockedGenerateText.mockImplementation(async (opts: any) => {
      if (JSON.stringify(opts?.messages ?? '').includes('long delegated work')) {
        // Crew turn hangs until we stop the lead — but a real generateText
        // rejects on abort, so race the gate against the abort signal.
        await Promise.race([
          gate,
          new Promise((_, rej) => opts.abortSignal?.addEventListener('abort', () => rej(new Error('Request was aborted')))),
        ]);
        if (opts.abortSignal?.aborted) throw new Error('Request was aborted');
        return { text: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any;
      }
      return { text: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any;
    });

    manager.dispatchTask('backend', 'eng', 'long delegated work');
    // Two distinct jobs: per-bot concurrency is 1, so one runs (held on the
    // gate) and one stays queued at stop time.
    manager.enqueue('qa', { trigger: 'chat', prompt: 'long delegated work A' });
    manager.enqueue('qa', { trigger: 'chat', prompt: 'long delegated work B' });
    await vi.waitFor(() => {
      expect(manager.getStatusSummaries().find(s => s.id === 'backend')?.state).toBe('running');
    });

    const result = await manager.stop('ceo');
    expect(result.crewStopped).toBe(3); // eng + backend + qa
    expect(result.heldJobs).toBe(1); // qa's queued job

    // Nothing in the subtree is running; all held.
    await vi.waitFor(() => {
      const states = Object.fromEntries(manager.getStatusSummaries().map(s => [s.id, s.state]));
      expect(states['backend']).not.toBe('running');
      expect(states['eng']).not.toBe('running');
    });
    for (const id of ['ceo', 'eng', 'backend', 'qa']) {
      expect(manager['held'].has(id)).toBe(true);
    }
    (released as unknown as (() => void) | null)?.();
  });

  it('starting the lead resumes the crew subtree except explicitly disabled crew', async () => {
    // Arrange held state across the fleet.
    await manager.stop('ceo');
    store.setEnabled('qa', false);

    const result = manager.start('ceo');
    expect(manager['held'].has('ceo')).toBe(false);
    expect(manager['held'].has('eng')).toBe(false);
    expect(manager['held'].has('backend')).toBe(false);
    // Explicitly disabled crew stay off.
    expect(manager['held'].has('qa')).toBe(true);
    expect(store.get('qa')!.enabled).toBe(false);
    void result;
  });

  it('stop of a mid-level lead only stops its own subtree, not its siblings', async () => {
    manager.enqueue('qa', { trigger: 'chat', prompt: 'qa task' });
    const result = await manager.stop('eng');
    expect(result.crewStopped).toBe(1); // backend only
    expect(manager['held'].has('qa')).toBe(false);
    expect(manager['held'].has('backend')).toBe(true);
  });
});