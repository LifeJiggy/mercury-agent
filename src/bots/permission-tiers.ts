import { BOT_DANGEROUS_TOOLS } from './store.js';

/**
 * Onboarding permission tiers — one clear question instead of silent
 * fail-closed defaults + manual file editing. Each tier is an explicit
 * tools.deny list (normalizeBotManifest respects an explicitly configured
 * tools block, so these grants stick). Whatever the tier, execution still
 * obeys the fail-closed PATH scopes — tools gate ≠ paths gate.
 */
export type PermissionTier = 'readonly' | 'builder' | 'operator' | 'full';

export const PERMISSION_TIERS: Record<PermissionTier, { label: string; description: string; deny: string[] }> = {
  readonly: {
    label: 'Read-only (recommended default)',
    description: 'Browse, search, read files, message bots. No execution, no file writes.',
    deny: [...BOT_DANGEROUS_TOOLS],
  },
  builder: {
    label: 'Builder — can write files',
    description: 'Read-only + create/edit/write files inside its granted scopes. Still no shell.',
    deny: ['run_command', 'delete_file', 'git_commit', 'git_push'],
  },
  operator: {
    label: 'Operator — can run commands',
    description: 'Builder + run_command. Execution still restricted to its granted path scopes (fail-closed), global blocked list applies.',
    deny: ['delete_file', 'git_commit', 'git_push'],
  },
  full: {
    label: 'Full access',
    description: 'Everything, including file deletion. For trusted automation only.',
    deny: [],
  },
};

export function isPermissionTier(value: string): value is PermissionTier {
  return value in PERMISSION_TIERS;
}

/** Apply a tier to a manifest (in place). */
export function applyPermissionTier(manifest: { tools?: { allow?: string[]; deny?: string[] } }, tier: PermissionTier): void {
  manifest.tools = { ...(manifest.tools ?? {}), deny: [...PERMISSION_TIERS[tier].deny] };
}