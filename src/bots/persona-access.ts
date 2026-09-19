import type { BotPathScope } from './types.js';

/**
 * Persona-declared access grants (`## Access` section in persona.md).
 *
 * The persona is where users describe their bot in their own words — so it is
 * also where they grant directory access. One bullet per grant:
 *
 *   ## Access
 *   - ~/cookies — read
 *   - ~/projects/site — read, write
 *   - /usr/local/bin/tool — execute
 *   - self — read, write
 *
 * Parsing is deliberately conservative: only list bullets inside the section
 * count, the path must look like a path (or `self`), and prose/example text
 * that isn't a bullet is ignored — so a template's inline example can never
 * grant anything. An absent or empty section changes nothing: the bot keeps
 * exactly the scopes from its permissions.yaml (fail-closed default).
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