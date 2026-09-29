import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { BotStore } from './store.js';
import type { BotManifest, BotPermissionsFile } from './types.js';

/**
 * Bot bundles — plug-and-play import/export (ADR-012 extension).
 *
 * A bundle is ONE transport-agnostic JSON document describing a bot or a
 * whole fleet: manifests, personas, and permissions. It is what makes the
 * on-disk fleet layout shareable and recreatable anywhere Mercury runs —
 * the CLI today, the local web dashboard, Mercury Code, or a third-party
 * site using Mercury as its agent backend (the same document can arrive via
 * file upload, HTTP POST, or paste).
 *
 * What is INCLUDED (the bot's identity + behavior):
 *   bot.yaml (sanitized), persona.md, permissions.yaml, skills/*.md
 * What is NEVER included (local state and secrets — they do not travel):
 *   sandbox/, journal.jsonl*, .env
 *
 * Fleet shape mirrors the physical layout: the lead is the bundle root; crew
 * entries keep their `parent` fields, which import resolves against ids
 * INSIDE the bundle (a crew exported alone exports as a solo — its lead did
 * not travel with it).
 */

export const BOT_BUNDLE_FORMAT = 'mercury-bot-bundle';
export const BOT_BUNDLE_VERSION = 1;

export interface BotBundleEntry {
  id: string;
  name: string;
  description?: string;
  /** Sanitized bot.yaml content (volatile fields stripped). */
  manifest: Record<string, unknown>;
  persona: string;
  /** The single source of truth for permissions, as-is. */
  permissions: BotPermissionsFile;
  /** Skill files (name → text content) when export included skills. */
  skills?: Record<string, string>;
}

export interface BotBundle {
  format: typeof BOT_BUNDLE_FORMAT;
  version: number;
  kind: 'bot' | 'fleet';
  /** The bundle's entry-point bot id. */
  root: string;
  exportedAt: string;
  /** Lead-first, parents-before-children order. */
  bots: BotBundleEntry[];
}

export interface BundleImportReport {
  created: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/** Manifest fields that describe THIS machine's runtime, not the bot. */
const VOLATILE_MANIFEST_FIELDS = ['createdAt', 'updatedAt'];

/**
 * Build a shareable bundle from a bot — or, for a fleet lead, the lead plus
 * its whole crew tree (recursively, matching the nested directory layout).
 */
export function buildBotBundle(store: BotStore, rootId: string, opts: { withSkills?: boolean } = {}): BotBundle {
  const root = store.get(rootId);
  if (!root) throw new Error(`No bot "${rootId}"`);
  const bots: BotBundleEntry[] = [];
  const collect = (id: string): void => {
    const m = store.get(id);
    if (!m) return;
    const entry: BotBundleEntry = {
      id: m.id,
      name: m.name,
      description: m.description,
      manifest: sanitizeManifest(m),
      persona: store.readPersona(id),
      permissions: store.ensurePermissions(id),
    };
    if (opts.withSkills) entry.skills = collectSkills(store.skillsDir(id));
    bots.push(entry);
    for (const crew of store.crewOf(id)) collect(crew.id);
  };
  collect(rootId);
  return {
    format: BOT_BUNDLE_FORMAT,
    version: BOT_BUNDLE_VERSION,
    kind: bots.length > 1 ? 'fleet' : 'bot',
    root: rootId,
    exportedAt: new Date().toISOString(),
    bots,
  };
}

/**
 * Recreate bots from a bundle into this store. Every imported bot starts
 * DISABLED (fail-closed: a shared bundle must never begin firing cron
 * routines or spending tokens unattended — enable consciously with
 * /bots enable). Existing ids are skipped (never overwritten) unless
 * opts.overwrite refreshes persona/permissions in place. Fleet nesting
 * falls out of the manifests' parent fields via the store's physical
 * layout; imports of a single crew bot arrive parentless (solo).
 */
export function importBotBundle(
  store: BotStore,
  bundle: BotBundle,
  opts: { overwrite?: boolean } = {},
): BundleImportReport {
  assertValidBundle(bundle);
  const report: BundleImportReport = { created: [], skipped: [] };
  // Parents before children: our builder already emits lead-first; enforce
  // it defensively so a hand-built bundle cannot create a child before its
  // parent's directory exists.
  for (const entry of orderedRootsFirst(bundle.bots, bundle.root)) {
    const exists = store.exists(entry.id);
    if (exists && !opts.overwrite) {
      report.skipped.push({ id: entry.id, reason: 'already exists (use overwrite to refresh persona/permissions)' });
      continue;
    }
    if (!exists) {
      store.create({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        persona: entry.persona,
        manifest: { ...entry.manifest, enabled: false } as Partial<BotManifest>,
      });
    } else if (opts.overwrite) {
      store.update(entry.id, m => {
        m.name = entry.name;
        m.description = entry.description;
        for (const [k, v] of Object.entries(entry.manifest)) {
          if (k === 'enabled' || k === 'id' || k === 'name') continue;
          (m as any)[k] = v;
        }
        m.enabled = store.get(entry.id)?.enabled ?? false;
      });
    }
    store.writePersona(entry.id, entry.persona);
    store.writePermissions(entry.id, entry.permissions);
    for (const [relPath, content] of Object.entries(entry.skills ?? {})) {
      const target = join(store.skillsDir(entry.id), relPath);
      mkdirSync(resolve(target, '..'), { recursive: true });
      writeFileSync(target, content, 'utf-8');
    }
    if (!exists) report.created.push(entry.id);
    else report.skipped.push({ id: entry.id, reason: 'existing bot refreshed (overwrite)' });
  }
  logger.info({ root: bundle.root, created: report.created.length, skipped: report.skipped.length }, 'Bot bundle imported');
  return report;
}

/** Structural validation — never throws on content, only on shape. */
function assertValidBundle(bundle: BotBundle): void {
  if (!bundle || bundle.format !== BOT_BUNDLE_FORMAT) {
    throw new Error(`Not a Mercury bot bundle (expected format "${BOT_BUNDLE_FORMAT}")`);
  }
  if (bundle.version !== BOT_BUNDLE_VERSION) {
    throw new Error(`Unsupported bundle version ${bundle.version} (this Mercury reads v${BOT_BUNDLE_VERSION})`);
  }
  if (!Array.isArray(bundle.bots) || bundle.bots.length === 0 || !bundle.bots.some(b => b.id === bundle.root)) {
    throw new Error('Bundle is missing its bots or its root entry');
  }
}

function sanitizeManifest(m: BotManifest): Record<string, unknown> {
  const out: Record<string, unknown> = { ...m } as any;
  for (const field of VOLATILE_MANIFEST_FIELDS) delete out[field];
  // Permissions travel in their own block (single source of truth) — the
  // legacy manifest copy is dropped so the file, not bot.yaml, decides.
  delete out.tools;
  return out;
}

/** Defensive topological order: every bot after its bundle parent (cycles tolerated → appended, then rejected by save's cycle guard). */
function orderedRootsFirst(entries: BotBundleEntry[], _root: string): BotBundleEntry[] {
  const pending = new Set(entries.map(e => e.id));
  const out: BotBundleEntry[] = [];
  const emit = (entry: BotBundleEntry): void => {
    if (!pending.has(entry.id)) return;
    pending.delete(entry.id);
    out.push(entry);
    const parent = entry.manifest.parent as string | undefined;
    if (parent) {
      const lead = entries.find(e => e.id === parent);
      if (lead) emit(lead);
    }
  };
  for (const entry of entries) emit(entry);
  for (const id of pending) out.push(entries.find(e => e.id === id)!);
  return out;
}

/** Default export location: ~/.mercury/exports/<id>.bot.json */
export function defaultBundlePath(rootId: string): string {
  const dir = join(getMercuryHome(), 'exports');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${rootId}.bot.json`);
}

export function writeBundle(bundle: BotBundle, outPath?: string): string {
  const path = outPath ?? defaultBundlePath(bundle.root);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(bundle, null, 2), 'utf-8');
  return path;
}

export function readBundle(path: string): BotBundle {
  return JSON.parse(readFileSync(path, 'utf-8')) as BotBundle;
}

/** Recurse a skills dir into {relativePath: textContent} (md/json/yaml only). */
function collectSkills(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const entry of readdirSafe(dir)) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_')) {
      Object.assign(out, collectSkills(join(dir, entry.name), join(prefix, entry.name)));
    } else if (entry.isFile() && /\.(md|json|ya?ml|txt)$/i.test(entry.name) && entry.name !== '.env') {
      try {
        const content = readFileSync(join(dir, entry.name), 'utf-8');
        if (content.length <= 256 * 1024) out[join(prefix, entry.name)] = content;
      } catch { /* unreadable skill file → skipped */ }
    }
  }
  return out;
}

function readdirSafe(dir: string): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> {
  try {
    return readdirSync(dir, { withFileTypes: true }) as any;
  } catch {
    return [];
  }
}