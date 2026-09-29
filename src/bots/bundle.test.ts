import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn() };
});

import { BotStore } from './store.js';
import { buildBotBundle, importBotBundle, readBundle, writeBundle, type BotBundle } from './bundle.js';

function freshRoot(): { root: string; store: BotStore } {
  const root = mkdtempSync(join(tmpdir(), 'mercury-bundle-'));
  return { root, store: new BotStore(join(root, 'bots')) };
}

describe('bot bundles (plug-and-play import/export)', () => {
  let root: string;
  let store: BotStore;

  beforeEach(() => {
    ({ root, store } = freshRoot());
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('exports a solo bot: manifest + persona + permissions, none of the local state', () => {
    store.create({ id: 'writer', name: 'Writer', description: 'Writes things' });
    store.writePermissions('writer', { paths: [{ scope: '~', read: true }], tools: { deny: ['git_push'] } });
    store.writePersona('writer', '# Writer\n\nSpare prose.\n');
    writeFileSync(join(store.sandboxDir('writer'), 'scratch.txt'), 'local state');
    writeFileSync(join(store.botDir('writer'), '.env'), 'SECRET=1');

    const bundle = buildBotBundle(store, 'writer');

    expect(bundle.format).toBe('mercury-bot-bundle');
    expect(bundle.kind).toBe('bot');
    expect(bundle.root).toBe('writer');
    expect(bundle.bots).toHaveLength(1);
    expect(bundle.bots[0].persona).toContain('Spare prose');
    expect(bundle.bots[0].permissions.paths).toEqual([{ scope: '~', read: true }]);
    expect(bundle.bots[0].manifest.createdAt).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toContain('local state');
    expect(JSON.stringify(bundle)).not.toContain('SECRET');
    // The tool gate travels in its own block (single source of truth).
    expect(bundle.bots[0].manifest.tools).toBeUndefined();
  });

  it('a fleet lead exports its whole crew tree, lead-first (DFS)', () => {
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    store.create({ id: 'eng', name: 'Eng', manifest: { fleetRole: 'lead', parent: 'ceo' } });
    store.create({ id: 'backend', name: 'Backend', manifest: { fleetRole: 'crew', parent: 'eng' } });
    store.create({ id: 'qa', name: 'QA', manifest: { fleetRole: 'crew', parent: 'ceo' } });

    const bundle = buildBotBundle(store, 'ceo');
    expect(bundle.kind).toBe('fleet');
    expect(bundle.bots.map(b => b.id)).toEqual(['ceo', 'eng', 'backend', 'qa']);
    expect(bundle.bots.find(b => b.id === 'backend')!.manifest.parent).toBe('eng');
  });

  it('a crew exported alone keeps its parent field (import resolves against the destination)', () => {
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    store.create({ id: 'crewmate', name: 'Crewmate', manifest: { fleetRole: 'crew', parent: 'ceo' } });
    const bundle = buildBotBundle(store, 'crewmate');
    expect(bundle.kind).toBe('bot');
    expect(bundle.bots[0].manifest.parent).toBe('ceo');
  });

  it('round-trips: export from one store, import into a fresh one — layout, persona, permissions intact', () => {
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    store.writePermissions('ceo', { paths: [{ scope: '~', read: true, write: true, execute: true }], autoApproveCommands: ['node *'] });
    store.writePersona('ceo', '# CEO\n\nDecisive.\n');
    store.create({ id: 'eng', name: 'Eng', manifest: { fleetRole: 'lead', parent: 'ceo' } });
    store.create({ id: 'backend', name: 'Backend', manifest: { fleetRole: 'crew', parent: 'eng' } });
    store.writePersona('backend', '# Backend\n\nShips APIs.\n');

    const bundle = buildBotBundle(store, 'ceo');
    const path = writeBundle(bundle, join(root, 'share', 'ceo.bot.json'));
    expect(existsSync(path)).toBe(true);
    const parsed = readBundle(path) as BotBundle;

    const dest = new BotStore(join(root, 'dest', 'bots'));
    const report = importBotBundle(dest, parsed);
    expect(report.created.sort()).toEqual(['backend', 'ceo', 'eng']);
    // Physical fleet layout recreated exactly.
    expect(existsSync(join(root, 'dest', 'bots', 'ceo', 'eng', 'backend', 'bot.yaml'))).toBe(true);
    // Persona + permissions (single source of truth) carried verbatim.
    expect(dest.readPersona('backend')).toContain('Ships APIs');
    expect(dest.readPermissions('ceo').autoApproveCommands).toEqual(['node *']);
    expect(dest.readPermissions('ceo').paths![0].execute).toBe(true);
    // Fail-closed: imported bots start DISABLED.
    expect(dest.get('ceo')!.enabled).toBe(false);
    // Crew nesting survived via the manifests.
    expect(dest.crewOf('ceo').map(m => m.id).sort()).toEqual(['eng']);
  });

  it('skips existing ids (never clobbers a running bot) unless overwrite is set', () => {
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    store.writePersona('ceo', '# CEO\n\nOriginal persona.\n');
    const bundle = buildBotBundle(store, 'ceo');

    const dest = new BotStore(join(root, 'dest', 'bots'));
    dest.create({ id: 'ceo', name: 'Local CEO' });
    dest.writePersona('ceo', '# CEO\n\nLocal persona.\n');

    const report = importBotBundle(dest, bundle);
    expect(report.created).toEqual([]);
    expect(report.skipped[0].reason).toContain('already exists');
    expect(dest.readPersona('ceo')).toContain('Local persona');

    importBotBundle(dest, bundle, { overwrite: true });
    expect(dest.readPersona('ceo')).toContain('Original persona');
    // Enabled state survives an overwrite refresh (never force-disabled).
    expect(dest.get('ceo')!.enabled).toBe(true);
  });

  it('rejects foreign documents loudly', () => {
    expect(() => importBotBundle(store, { hello: 'world' } as unknown as BotBundle)).toThrow(/Not a Mercury bot bundle/);
  });
});