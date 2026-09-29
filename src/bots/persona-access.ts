import type { BotPathScope } from './types.js';

/**
 * Persona-declared access grants (`## Access` section in persona.md).
 *
 * DEPRECATED as a permission source: permissions.yaml is the single source
 * of truth, and the persona carries character only. This parser survives for
 * ONE purpose — the one-shot startup migration that moves legacy `## Access`
 * grants into the bot's permissions.yaml and strips the section from the
 * persona file (stripPersonaAccessSection). Nothing at runtime reads grants
 * from a persona anymore.
 *
 * Parsing is deliberately conservative: only list bullets inside the section
 * count, the path must look like a path (or `self`), and prose/example text
 * that isn't a bullet is ignored.
 */
export function parsePersonaAccess(persona: string): BotPathScope[] {
  if (!persona) return [];
  const grants: BotPathScope[] = [];
  let inSection = false;
  for (const line of persona.split('\n')) {
    if (/^#{1,2}\s/.test(line)) {
      inSection = /^##\s+Access\b/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (!bullet) continue;
    const grant = parseGrant(bullet[1]);
    if (grant) grants.push(grant);
  }
  return grants;
}

/**
 * Migration companion: remove the `## Access` section (and any trailing
 * prose that belonged to it) from a persona, leaving the rest intact.
 */
export function stripPersonaAccessSection(persona: string): string {
  if (!persona) return persona;
  const lines = persona.split('\n');
  const start = lines.findIndex(l => /^##\s+Access\b/i.test(l));
  if (start === -1) return persona;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) { end = i; break; }
  }
  const replacement = [
    '## Permissions',
    '',
    'Permissions live exclusively in your permissions.yaml file (the single',
    'source of truth). Your private `sandbox/`, the fleet `_shared/` folder',
    'and your own profile directory are always yours.',
  ];
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n');
}

function parseGrant(bullet: string): BotPathScope | null {
  // Path = quoted text first (…/`…`), else the first whitespace token.
  const quoted = /["'`]([^"'`]+)["'`]/.exec(bullet);
  let rawPath = quoted?.[1] ?? bullet.split(/\s+/)[0] ?? '';
  rawPath = rawPath.trim().replace(/[,.;:]+$/, '');
  if (!looksLikePath(rawPath)) return null;

  const modes = { read: false, write: false, execute: false };
  const modePart = bullet.slice(bullet.indexOf(rawPath) + rawPath.length);
  for (const word of modePart.toLowerCase().split(/[^a-z+]+/)) {
    if (word === 'read' || word === 'r') modes.read = true;
    else if (word === 'write' || word === 'w') modes.write = true;
    else if (word === 'execute' || word === 'exec' || word === 'run' || word === 'x') modes.execute = true;
  }
  // A bare path (no modes stated) grants read — the least-privilege default.
  if (!modes.read && !modes.write && !modes.execute) modes.read = true;
  return { scope: rawPath, ...modes };
}

function looksLikePath(value: string): boolean {
  if (value === 'self') return true;
  if (value.length === 0 || value.length > 512) return false;
  return /^(?:~|\/|\.{1,2}\/|[A-Za-z]:[\\/]|\\\\)/.test(value);
}