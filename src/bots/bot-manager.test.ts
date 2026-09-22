import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock only generateText; tool()/zodSchema/stepCountIs must stay real so the
// CapabilityRegistry tool factories still construct.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

import { generateText } from 'ai';
import { BotManager } from './bot-manager.js';
import { BotStore } from './store.js';
import { createBotCapabilityRegistry, filterBotTools } from './registry-factory.js';
import { SkillLoader } from '../skills/loader.js';
import { getDefaultConfig, type MercuryConfig } from '../utils/config.js';
import type { BotManifest } from './types.js';

const mockedGenerateText = vi.mocked(generateText);

function scriptedProvider(name = 'stub') {
  return {
    name,
    model: 'stub-model',
    generateText: async () => ({ text: 'ok', inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'stub-model', provider: name }),
    streamText: async function* () { yield { text: 'ok', done: true }; },
    isAvailable: () => true,
    getModelInstance: () => ({}),
    getModel: () => 'stub-model',
  } as any;
}

const providersRegistry = {
  get: (name?: string) => (name === 'stub' ? scriptedProvider('stub') : undefined),
  getDefault: () => scriptedProvider('default'),
} as any;

const tokenBudget = {
  recordUsage: () => {},
  getRemaining: () => 100000,
  getStatusText: () => 'budget ok',
  getUsagePercentage: () => 0,
} as any;

function makeManager(root: string, overrides: Partial<MercuryConfig> = {}): BotManager {
  const config = getDefaultConfig() as MercuryConfig;
  config.bots.maxConcurrent = 4;
  Object.assign(config, overrides);
  return new BotManager({
    config,
    providers: providersRegistry,
    tokenBudget,
    store: new BotStore(join(root, 'bots')),
    userMemoryFactory: () => null, // no SQLite dependency in unit tests
  });
}

function seedBot(store: BotStore, id: string, manifestOverrides: Partial<BotManifest> = {}) {
  return store.create({ id, name: id.toUpperCase(), manifest: manifestOverrides });
}

beforeEach(() => {
  mockedGenerateText.mockReset();
});

describe('BotManager queue + turn lifecycle', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-manager-'));
    store = new BotStore(join(root, 'bots'));
    manager = makeManager(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects jobs for unknown and disabled bots with typed reasons', async () => {
    expect(manager.enqueue('ghost', { trigger: 'chat', prompt: 'hi' })).toMatchObject({ accepted: false, reasonCode: 'target_unknown' });
    seedBot(store, 'sleepy', { enabled: false });
    expect(manager.enqueue('sleepy', { trigger: 'chat', prompt: 'hi' })).toMatchObject({ accepted: false, reasonCode: 'target_disabled' });
  });

  it('runs a chat turn to completion, journals it, and notifies', async () => {
    mockedGenerateText.mockResolvedValue({ text: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } } as any);
    seedBot(store, 'researcher');
    const delivered: Array<{ target: string; message: string }> = [];
    manager['notify'] = async (_t, target, message) => { delivered.push({ target, message }); };

    const result = manager.enqueue('researcher', { trigger: 'chat', prompt: 'Summarize the market', source: { channelType: 'cli', channelId: 'current' } });
    expect(result.accepted).toBe(true);
    // pump is synchronous-ish; the turn runs as a detached promise — wait for it
    await vi.waitFor(() => {
      const records = manager.getJournal('researcher');
      expect(records.length).toBe(1);
      expect(records[0].state).toBe('completed');
    });
    // Hermes/OpenClaw contract: the full result lands in the bot's OWN thread;
    // the CLI session that asked gets NOTHING — no pointer into the main chat
    // (a delayed routine/retry run would otherwise print into whatever
    // session is open days later — the thread leak).
    await vi.waitFor(() => {
      expect(delivered.some(d => d.target === 'bot:researcher' && d.message.includes('done'))).toBe(true);
    });
    expect(delivered.every(d => d.target === 'bot:researcher')).toBe(true);
    expect(delivered.some(d => d.message.includes('finished its task'))).toBe(false);
    const summary = manager.getStatusSummaries().find(s => s.id === 'researcher');
    expect(summary?.state).toBe('idle');
    expect(summary?.lastRunState).toBe('completed');
  });

  it('remote source channels still receive the full result (no bot threads there)', async () => {
    mockedGenerateText.mockResolvedValue({ text: 'remote done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } } as any);
    seedBot(store, 'courier');
    const delivered: Array<{ target: string; message: string }> = [];
    manager['notify'] = async (t, target, message) => { delivered.push({ target: `${t}:${target}`, message }); };
    manager.enqueue('courier', { trigger: 'chat', prompt: 'go', source: { channelType: 'telegram', channelId: 'chat-42' } });
    await vi.waitFor(() => {
      expect(delivered.some(d => d.target === 'telegram:chat-42' && d.message.includes('remote done'))).toBe(true);
    });
    // The bot thread still gets it too.
    expect(delivered.some(d => d.target === 'cli:bot:courier' && d.message.includes('remote done'))).toBe(true);
  });

  it('pauses the bot for the rest of the day when the daily token budget is hit', async () => {
    mockedGenerateText.mockImplementation(async (opts: any) => {
      opts.onStepFinish?.({ usage: { inputTokens: 100, outputTokens: 100 } });
      return { text: 'ok', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 100 } } as any;
    });
    seedBot(store, 'thrifty', { autonomy: { dailyTokenBudget: 1 } });
    manager.enqueue('thrifty', { trigger: 'chat', prompt: 'go' });
    await vi.waitFor(() => {
      const summary = manager.getStatusSummaries().find(s => s.id === 'thrifty');
      expect(summary?.state).toBe('paused');
    });
    // Budget-paused bots do not drain their queue
    expect(manager.getQueuedCount('thrifty')).toBe(0);
  });

  it('retries transient provider failures with backoff, bounded', async () => {
    mockedGenerateText.mockRejectedValue(new Error('HTTP 429: too many requests'));
    seedBot(store, 'flaky', { autonomy: { dailyTokenBudget: 100000 } });
    vi.useFakeTimers();
    try {
      manager.enqueue('flaky', { trigger: 'chat', prompt: 'go' });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(manager.getJournal('flaky').length).toBe(1));
      expect(manager.getJournal('flaky')[0].reasonCode).toBe('provider_rate_limit');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop holds queued jobs (durable, nothing lost) and start resumes them', async () => {
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    mockedGenerateText.mockImplementation(() => gate.then(() => ({ text: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any)));
    seedBot(store, 'worker');
    manager.enqueue('worker', { trigger: 'chat', prompt: 'one' });
    manager.enqueue('worker', { trigger: 'chat', prompt: 'two' }); // queues behind the running turn
    await vi.waitFor(() => expect(manager.getQueuedCount('worker')).toBe(1));

    const stop = await manager.stop('worker');
    expect(stop.halted).toBe(true);
    expect(stop.heldJobs).toBe(1);
    expect(manager.getQueuedCount('worker')).toBe(0);
    // The queued job is NOT destroyed — its durable row stays pending.
    expect(manager.queue.pendingJobs('worker').map(j => j.prompt)).toContain('two');

    release(); // let the in-flight turn finish
    await vi.waitFor(() => expect(manager.getJournal('worker').length).toBe(1));

    const start = manager.start('worker');
    expect(start.resumed).toBe(1);
    await vi.waitFor(() => expect(manager.getJournal('worker').length).toBe(2));
  });

  it('start on an idle stopped bot resumes nothing and reports it', async () => {
    seedBot(store, 'calm');
    await manager.stop('calm'); // nothing running, nothing queued
    expect(manager.start('calm').resumed).toBe(0);
    expect(manager.getStatusSummaries().find(s => s.id === 'calm')?.state).toBe('idle');
  });

  it('runNow fires a configured routine now, rejects unknown ones, and wakes bare', async () => {
    mockedGenerateText.mockResolvedValue({ text: 'digest done', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 5 } } as any);
    seedBot(store, 'crony', { schedules: [{ name: 'digest', cron: '0 9 * * *', prompt: 'Write the daily digest' }] });
    // Name resolution is case-insensitive; the run is journalled with trigger cron.
    expect(manager.runNow('crony', 'DIGEST').accepted).toBe(true);
    await vi.waitFor(() => {
      const records = manager.getJournal('crony');
      expect(records.length).toBe(1);
      expect(records[0].trigger).toBe('cron');
      expect(records[0].summary).toContain('digest done');
    });
    expect(manager.runNow('crony', 'nope')).toMatchObject({ accepted: false, reasonCode: 'routine_unknown' });
    expect(manager.runNow('ghost', 'digest')).toMatchObject({ accepted: false, reasonCode: 'target_unknown' });
    // No routine named → a bare wake turn with the canned wake prompt.
    expect(manager.runNow('crony').accepted).toBe(true);
  });

  it('tells the bot its sandbox paths and the shared-folder standing rule', async () => {
    seedBot(store, 'pathfinder');
    let systemPrompt = '';
    mockedGenerateText.mockImplementation(async (opts: any) => {
      systemPrompt = opts.system ?? '';
      return { text: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any;
    });
    manager.enqueue('pathfinder', { trigger: 'chat', prompt: 'hi' });
    await vi.waitFor(() => {
      expect(systemPrompt).toContain(store.sandboxDir('pathfinder'));
      expect(systemPrompt).toContain('_shared');
      expect(systemPrompt).toContain('even when not explicitly asked');
    });
  });

  it('degrades to a stateless bot when the memory store cannot be built', async () => {
    // Simulates a SQLite-less device: the store factory throws.
    const config = getDefaultConfig() as MercuryConfig;
    config.bots.maxConcurrent = 4;
    const manager = new BotManager({
      config,
      providers: providersRegistry,
      tokenBudget,
      store: new BotStore(join(root, 'bots')),
      userMemoryFactory: () => { throw new Error('better-sqlite3 is not available'); },
    });
    mockedGenerateText.mockResolvedValue({ text: 'stateless ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any);
    seedBot(store, 'nodb');
    manager.enqueue('nodb', { trigger: 'chat', prompt: 'hello' });
    await vi.waitFor(() => {
      const records = manager.getJournal('nodb');
      expect(records.length).toBe(1);
      expect(records[0].state).toBe('completed');
    });
  });
});

describe('Main-agent bots awareness (system prompt section)', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-aware-'));
    store = new BotStore(join(root, 'bots'));
    manager = makeManager(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists bots with descriptions and live states so the main chat can answer precisely', () => {
    store.create({ id: 'researcher', name: 'Research', description: 'Deep research specialist' });
    store.create({ id: 'publisher', name: 'Publisher', manifest: { enabled: false } });
    const section = manager.getSystemPromptSection();
    expect(section).toContain('**Research** (`researcher`) — Deep research specialist');
    expect(section).toContain('idle');
    expect(section).toContain('disabled');
  });

  it('documents the control commands and the dispatch tool', () => {
    seedBot(store, 'researcher');
    const section = manager.getSystemPromptSection();
    expect(section).toContain('/bot <id> <message>');
    expect(section).toContain('dispatch_bot');
    expect(section).toContain('/bots open <id>');
    // The main agent must not promise main-chat delivery — results live in
    // the bot thread only (§3.1, thread-leak fix).
    expect(section).toContain('never in this chat');
  });

  it('empty fleet produces NO prompt section (zero drift for botless users)', () => {
    const section = manager.getSystemPromptSection();
    expect(section).toBe('');
  });

  it('dispatch_bot tool routes through the handler with name resolution', async () => {
    const { createDispatchBotTool } = await import('./tools/dispatch-bot.js');
    store.create({ id: 'researcher', name: 'Research' });
    const calls: Array<{ bot: string; message: string }> = [];
    const tool = createDispatchBotTool((botId, message) => {
      const resolved = manager.resolveBotId(botId);
      calls.push({ bot: resolved ?? '', message });
      if (!resolved) return { accepted: false, reasonCode: 'target_unknown' };
      return { accepted: true, jobId: 'j1' };
    }, () => ({ channelType: 'cli', channelId: 'current' })) as any;
    const ok = await tool.execute({ bot: 'Research', message: 'do the thing' });
    expect(ok).toContain('Dispatched');
    expect(calls[0].bot).toBe('researcher');
    const unknown = await tool.execute({ bot: 'ghost', message: 'x' });
    expect(unknown).toContain('target_unknown');
  });
});

describe('BotManager mailboxes (bot-to-bot comms)', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-mail-'));
    store = new BotStore(join(root, 'bots'));
    manager = makeManager(root);
    seedBot(store, 'researcher');
    seedBot(store, 'publisher');
    seedBot(store, 'offline', { enabled: false });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns typed failures for unknown/disabled targets', () => {
    expect(manager.sendToBot('ghost', 'researcher', 'hi')).toMatchObject({ accepted: false, reasonCode: 'target_unknown' });
    expect(manager.sendToBot('offline', 'researcher', 'hi')).toMatchObject({ accepted: false, reasonCode: 'target_disabled' });
  });

  it('delivers mail and wakes an idle bot, attributed in the prompt', async () => {
    mockedGenerateText.mockImplementation(async ({ messages }: any) => {
      const sawMail = JSON.stringify(messages).includes('Message from 🤖 researcher');
      return { text: sawMail ? 'consumed handoff' : 'idle check', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any;
    });
    const result = manager.sendToBot('publisher', 'researcher', 'Here are the findings');
    expect(result.accepted).toBe(true);
    await vi.waitFor(() => {
      const records = manager.getJournal('publisher');
      expect(records.length).toBe(1);
      expect(records[0].trigger).toBe('mailbox');
    });
    // The captured turn messages included the attributed mailbox content
    const firstCall = mockedGenerateText.mock.calls[0][0] as any;
    expect(JSON.stringify(firstCall.messages)).toContain('Message from 🤖 researcher');
    expect(JSON.stringify(firstCall.messages)).toContain('Here are the findings');
  });

  it('queues mail behind an active turn instead of dropping it', () => {
    // Simulate a running turn
    manager['running'].set('publisher', new Set(['busy']));
    manager.sendToBot('publisher', 'researcher', 'more findings');
    expect(manager.peekMailbox('publisher')).toHaveLength(1);
    // No mailbox-triggered job enqueued while running — mail waits for drain
    expect(manager.getQueuedCount('publisher')).toBe(0);
  });
});

describe('Per-bot permission isolation (fail-closed)', () => {
  let root: string;
  let store: BotStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-perms-'));
    store = new BotStore(join(root, 'bots'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('builds an isolated registry with no ask handler and a bot channel context', () => {
    const manifest = store.create({ id: 'writer', name: 'Writer' }) as BotManifest;
    const registry = createBotCapabilityRegistry({
      botId: 'writer',
      manifest,
      botDir: store.botDir('writer'),
      permissions: store.readPermissions('writer'),
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    const pm = registry.permissions;
    expect(pm.getCurrentChannelType()).toBe('bot');
    // Fail-closed: with no ask handler and no allow-all, every approval denies
    expect(pm.isAutoApproveAll()).toBe(false);
    // Default all-cwd scope replaced by the bot's own dir only
    const scopes = pm.getManifest().capabilities.filesystem.scopes;
    expect(scopes).toHaveLength(1);
    expect(scopes[0].path).toBe(store.botDir('writer'));
    // Shell auto-approve list emptied; dangerous blocklist retained
    expect(pm.getManifest().capabilities.shell.autoApproved).toEqual([]);
    expect(pm.getManifest().capabilities.shell.blocked).toContain('sudo *');
  });

  it('persona ## Access grants merge additively into the registry scopes', () => {
    const manifest = store.create({ id: 'cookiebot', name: 'Cookiebot' }) as BotManifest;
    store.writePersona('cookiebot', `# Cookiebot\n\n## Access\n\n- ~/cookies — read\n- /tmp/execdir — execute\n`);
    const registry = createBotCapabilityRegistry({
      botId: 'cookiebot',
      manifest,
      botDir: store.botDir('cookiebot'),
      permissions: store.readPermissions('cookiebot'),
      persona: store.readPersona('cookiebot'),
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    const scopes = registry.permissions.getManifest().capabilities.filesystem.scopes;
    // Own profile dir (default grant) still there, plus the persona grants.
    expect(scopes.some(s => s.path === store.botDir('cookiebot'))).toBe(true);
    expect(scopes.some(s => s.path.endsWith('/cookies') && s.read && !s.write)).toBe(true);
    expect(scopes.some(s => s.path === '/tmp/execdir' && s.execute)).toBe(true);
  });

  it('a malformed permissions.yaml entry (missing "scope") is skipped, not fatal', () => {
    // Hand-edit typo class: `socpe:` instead of `scope:` — the registry build
    // must never crash every turn over it (the entry is just skipped).
    const manifest = store.create({ id: 'typo', name: 'Typo' }) as BotManifest;
    store.writePermissions('typo', {
      paths: [
        { scope: 'self', read: true, write: true },
        { socpe: '/tmp/cookies', read: true } as unknown as { scope: string; read: boolean },
      ],
    });
    const registry = createBotCapabilityRegistry({
      botId: 'typo',
      manifest,
      botDir: store.botDir('typo'),
      permissions: store.readPermissions('typo'),
      persona: store.readPersona('typo'),
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    const scopes = registry.permissions.getManifest().capabilities.filesystem.scopes;
    // The malformed entry contributed nothing; the valid self scope survived.
    expect(scopes).toHaveLength(1);
    expect(scopes[0].path).toBe(store.botDir('typo'));
  });

  it('a persona without an Access section changes nothing (current permissions apply)', () => {
    const manifest = store.create({ id: 'plainbot', name: 'Plainbot' }) as BotManifest;
    const registry = createBotCapabilityRegistry({
      botId: 'plainbot',
      manifest,
      botDir: store.botDir('plainbot'),
      permissions: store.readPermissions('plainbot'),
      persona: store.readPersona('plainbot'), // default template: examples only, no grant bullets
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    const scopes = registry.permissions.getManifest().capabilities.filesystem.scopes;
    expect(scopes).toHaveLength(1);
    expect(scopes[0].path).toBe(store.botDir('plainbot'));
  });

  it('grants the private sandbox and fleet-shared folder implicitly (rw+x)', () => {
    const manifest = store.create({ id: 'sandboxer', name: 'Sandboxer' }) as BotManifest;
    // create() materializes both sandbox areas
    expect(existsSync(store.sandboxDir('sandboxer'))).toBe(true);
    expect(existsSync(store.sharedSandboxDir())).toBe(true);
    // and the shared dir is never mistaken for a bot
    expect(store.list().map(m => m.id)).toEqual(['sandboxer']);
    const registry = createBotCapabilityRegistry({
      botId: 'sandboxer',
      manifest,
      botDir: store.botDir('sandboxer'),
      permissions: store.readPermissions('sandboxer'),
      persona: store.readPersona('sandboxer'),
      sandbox: { workspace: store.sandboxDir('sandboxer'), shared: store.sharedSandboxDir() },
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    const scopes = registry.permissions.getManifest().capabilities.filesystem.scopes;
    const workspace = scopes.find(s => s.path === store.sandboxDir('sandboxer'));
    const shared = scopes.find(s => s.path === store.sharedSandboxDir());
    expect(workspace).toMatchObject({ read: true, write: true, execute: true });
    expect(shared).toMatchObject({ read: true, write: true, execute: true });
  });

  it('bot toolset gains list_skills + use_skill; install_skill stays stripped', () => {
    const manifest = store.create({ id: 'skillful', name: 'Skillful' }) as BotManifest;
    const loader = new SkillLoader(join(root, 'skills'), { seedDefaults: false });
    loader.discover();
    const registry = createBotCapabilityRegistry({
      botId: 'skillful',
      manifest,
      botDir: store.botDir('skillful'),
      permissions: store.readPermissions('skillful'),
      skillLoader: loader,
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    const tools = registry.getTools();
    expect(tools.list_skills).toBeDefined();
    expect(tools.use_skill).toBeDefined();
    const filtered = filterBotTools({ ...tools }, manifest);
    expect(filtered.list_skills).toBeDefined();
    expect(filtered.use_skill).toBeDefined();
    expect(filtered.install_skill).toBeUndefined();
  });

  it('fs write outside the bot scope is denied without prompting', async () => {
    const manifest = store.create({ id: 'writer', name: 'Writer' }) as BotManifest;
    const registry = createBotCapabilityRegistry({
      botId: 'writer',
      manifest,
      botDir: store.botDir('writer'),
      permissions: store.readPermissions('writer'),
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    const outside = join(root, 'elsewhere.txt');
    const verdict = await registry.permissions.checkFsAccess(outside, 'write');
    expect(verdict.allowed).toBe(false);
    const inside = join(store.botDir('writer'), 'note.md');
    const insideVerdict = await registry.permissions.checkFsAccess(inside, 'write');
    expect(insideVerdict.allowed).toBe(true);
  });

  it('strips interactive and global-mutation tools from every bot toolset', () => {
    const manifest = store.create({ id: 'writer', name: 'Writer' }) as BotManifest;
    const registry = createBotCapabilityRegistry({
      botId: 'writer',
      manifest,
      botDir: store.botDir('writer'),
      permissions: store.readPermissions('writer'),
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    const tools = filterBotTools(registry.getTools(), manifest);
    for (const forbidden of ['ask_user', 'approve_scope', 'approve_command', 'update_plan', 'delegate_task', 'install_skill', 'schedule_task', 'bot_send']) {
      expect(tools[forbidden]).toBeUndefined();
    }
    // Dangerous tools are denied by default (normalizeBotManifest)
    expect(tools['run_command']).toBeUndefined();
    expect(tools['write_file']).toBeUndefined();
    // Read-only tools survive the default deny list
    expect(tools['read_file']).toBeDefined();
    expect(tools['list_dir']).toBeDefined();
  });

  it('a non-empty allow list restricts the toolset exactly to that list', () => {
    const manifest = store.create({
      id: 'reader',
      name: 'Reader',
      manifest: { tools: { allow: ['read_file'], deny: [] } },
    }) as BotManifest;
    const registry = createBotCapabilityRegistry({
      botId: 'reader',
      manifest,
      botDir: store.botDir('reader'),
      permissions: store.readPermissions('reader'),
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    const tools = filterBotTools(registry.getTools(), manifest);
    expect(Object.keys(tools)).toEqual(['read_file']);
  });

  it('bot-blocked commands extend the shell denylist', () => {
    const manifest = store.create({ id: 'writer', name: 'Writer' }) as BotManifest;
    store.writePermissions('writer', { paths: [{ scope: 'self', read: true, write: true }], blockedCommands: ['curl *'] });
    const registry = createBotCapabilityRegistry({
      botId: 'writer',
      manifest,
      botDir: store.botDir('writer'),
      permissions: store.readPermissions('writer'),
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    expect(registry.permissions.getManifest().capabilities.shell.blocked).toContain('curl *');
  });
});

describe('bot_send tool scoping', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-send-'));
    store = new BotStore(join(root, 'bots'));
    manager = makeManager(root);
    seedBot(store, 'publisher');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is only available for bots with a configured roster and rejects unlinked targets', async () => {
    const { createBotSendTool } = await import('./tools/bot-send.js');
    // The publisher bot is idle, so sendToBot wakes it and its wake-turn
    // drains the mailbox immediately — verify via the journal instead.
    mockedGenerateText.mockImplementation(async ({ messages }: any) => {
      void messages;
      return { text: 'handled', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any;
    });
    const tool = createBotSendTool(manager, 'researcher', ['publisher']) as any;
    const denied = await tool.execute({ target: 'stranger', message: 'hi' });
    expect(denied).toContain('not configured');
    const ok = await tool.execute({ target: 'publisher', message: 'findings' });
    expect(ok).toContain('Queued for publisher');
    await vi.waitFor(() => {
      const records = manager.getJournal('publisher');
      expect(records.length).toBe(1);
      expect(records[0].trigger).toBe('mailbox');
    });
    const firstCall = mockedGenerateText.mock.calls[0][0] as any;
    expect(JSON.stringify(firstCall.messages)).toContain('Message from 🤖 researcher');
  });
});
describe('Bot skill access (native + own library)', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-skills-'));
    store = new BotStore(join(root, 'bots'));
    manager = makeManager(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSkill(dir: string, name: string, body: string) {
    const skillDir = join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\nallowed-tools: []\n---\n\n${body}\n`);
  }

  it('turn prompts list native skills AND the bot\'s own library', async () => {
    // Default skills root = <botsRoot>/../skills — the native library.
    writeSkill(join(root, 'skills'), 'shared-procedure', 'Native procedure steps.');
    // The bot's OWN library: synthesized or hand-authored, bot-private.
    writeSkill(store.skillsDir('skilled'), 'own-procedure', 'The bot learned this itself.');
    seedBot(store, 'skilled');
    let systemPrompt = '';
    mockedGenerateText.mockImplementation(async (opts: any) => {
      systemPrompt = opts.system ?? '';
      return { text: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any;
    });
    manager.enqueue('skilled', { trigger: 'chat', prompt: 'hi' });
    await vi.waitFor(() => {
      expect(systemPrompt).toContain('own-procedure');
      expect(systemPrompt).toContain('shared-procedure');
    });
  });
});

describe('Bot fleets (lead + crew)', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-fleet-'));
    store = new BotStore(join(root, 'bots'));
    manager = makeManager(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function setupFleet() {
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    manager.addCrew('ceo', { id: 'researcher', name: 'Researcher', description: 'Research', persona: '# Researcher\n\nStudies markets.' });
    manager.addCrew('ceo', { id: 'writer', name: 'Writer', persona: '# Writer\n\nWrites copy.' });
  }

  function runtimeFor(id: string) {
    return (manager as unknown as { getOrCreateRuntime(id: string, m: BotManifest): { tools: Record<string, any> } }).getOrCreateRuntime(id, store.get(id)!);
  }

  it('addCrew enforces the lead relationship, the crew cap, and fail-closed defaults', () => {
    setupFleet();
    expect(store.get('researcher')?.fleetRole).toBe('crew');
    expect(store.get('researcher')?.parent).toBe('ceo');
    expect(store.get('researcher')?.comms?.canMessage).toEqual(['ceo']);
    for (let i = 0; i < 4; i++) manager.addCrew('ceo', { id: `extra${i}`, name: `Extra${i}` });
    expect(manager.addCrew('ceo', { id: 'over-cap', name: 'Over' })).toMatchObject({ ok: false });
    store.create({ id: 'solo-bot', name: 'Solo' });
    expect(manager.addCrew('solo-bot', { id: 'x', name: 'X' })).toMatchObject({ ok: false }); // not a lead
    expect(manager.addCrew('ceo', { id: 'researcher', name: 'Dup' })).toMatchObject({ ok: false }); // exists
  });

  it('delegated tasks return results to the lead mailbox (attributed)', async () => {
    mockedGenerateText.mockResolvedValue({ text: 'MARKET REPORT: all clear', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 5 } } as any);
    setupFleet();
    // Spy on delivery: the lead's wake turn would drain the mailbox before we
    // can peek — the sendToBot call itself is the observable contract.
    const sendSpy = vi.spyOn(manager, 'sendToBot');
    const dispatch = manager.dispatchTask('researcher', 'ceo', 'Study the market');
    expect(dispatch.accepted).toBe(true);
    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalledWith('ceo', 'researcher', expect.stringContaining('MARKET REPORT'));
    });
    sendSpy.mockRestore();
  });

  it('plain mailbox mail never triggers a result reply (no ping-pong)', async () => {
    mockedGenerateText.mockResolvedValue({ text: 'noted', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any);
    setupFleet();
    manager.sendToBot('researcher', 'ceo', 'fyi only, no action');
    await vi.waitFor(() => expect(manager.getJournal('researcher').length).toBe(1));
    await new Promise(r => setTimeout(r, 50)); // let any detached follow-up turns settle
    expect(manager.peekMailbox('ceo')).toHaveLength(0);
  });

  it('leads get fleet tools; bot_spawn/bot_retire manage the crew within the cap', async () => {
    mockedGenerateText.mockResolvedValue({ text: 'A meticulous QA reviewer persona.', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any);
    setupFleet();
    const tools = runtimeFor('ceo').tools;
    expect(tools.fleet_status).toBeDefined();
    expect(tools.bot_spawn).toBeDefined();
    expect(tools.bot_retire).toBeDefined();

    const spawn = tools.bot_spawn as any;
    const out = await spawn.execute({ id: 'qa', name: 'QA', description: 'Reviews posts', persona: 'A meticulous QA reviewer who checks every claim.' }, {} as any);
    expect(out).toContain('qa');
    expect(store.get('qa')?.parent).toBe('ceo');

    let last = '';
    for (let i = 0; i < 5; i++) {
      last = await spawn.execute({ id: `filler${i}`, name: `F${i}`, description: 'x', persona: 'Filler persona for capacity testing purposes.' }, {} as any);
    }
    expect(last).toContain('crew cap');

    const retire = tools.bot_retire as any;
    expect(await retire.execute({ id: 'writer' }, {} as any)).toContain('retired');
    expect(store.get('writer')).toBeNull();
    // Ownership: ceo cannot retire another lead's crew
    store.create({ id: 'rival', name: 'Rival', manifest: { fleetRole: 'lead' } });
    manager.addCrew('rival', { id: 'guard', name: 'Guard' });
    expect(await retire.execute({ id: 'guard' }, {} as any)).toContain('is not crew');
  });

  it('solo bots never get fleet tools', () => {
    store.create({ id: 'loner', name: 'Loner' });
    const tools = runtimeFor('loner').tools;
    expect(tools.fleet_status).toBeUndefined();
    expect(tools.bot_spawn).toBeUndefined();
  });
});
