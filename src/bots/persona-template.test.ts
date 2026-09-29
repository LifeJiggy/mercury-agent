import { describe, it, expect, beforeEach } from 'vitest';
import { refinePersona } from './persona-template.js';
import { PERMISSION_TIERS, applyPermissionTier } from './permission-tiers.js';

const scriptedResponses: string[] = [];

function stubProvider() {
  return {
    name: 'stub',
    model: 'stub-model',
    generateText: async () => ({
      text: scriptedResponses.shift() ?? '',
      inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'stub', provider: 'stub',
    }),
    streamText: async function* () { yield { text: '', done: true }; },
    isAvailable: () => true,
    getModelInstance: () => ({}),
    getModel: () => 'stub-model',
  } as any;
}

const goodTemplate = `# Research

A focused deep-research specialist.

## Character

Curious but skeptical curator; verifies before recommending.

## Standing instructions

- Verify repos are active before recommending
- Never recommend unverified sources
- Prefer depth over volume

## Output

Lead with a one-line summary, then compact sections.
`;

describe('refinePersona (convert to template)', () => {
  beforeEach(() => {
    scriptedResponses.length = 0;
  });

  it('restructures free-form persona text into the template shape', async () => {
    scriptedResponses.push(goodTemplate);
    const result = await refinePersona(
      'I want a research bot that verifies repos are active before recommending, never recommends unverified stuff, and likes depth over volume. Skeptical tone.',
      'Research',
      stubProvider(),
    );
    expect(result).toContain('# Research');
    expect(result).toContain('## Standing instructions');
    expect(result).toContain('verifies');
    expect(result).toContain('## Output');
  });

  it('returns null for unusable output (missing sections, too short, code fences)', async () => {
    scriptedResponses.push('Sure! Here is your persona.'); // no structure
    expect(await refinePersona('raw', 'R', stubProvider())).toBeNull();
    scriptedResponses.push('# R'); // too short
    expect(await refinePersona('raw', 'R', stubProvider())).toBeNull();
  });

  it('is non-fatal when the provider throws — raw persona is kept instead', async () => {
    const throwing = { ...stubProvider(), generateText: async () => { throw new Error('HTTP 500'); } } as any;
    expect(await refinePersona('raw persona text', 'R', throwing)).toBeNull();
  });

  it('big personas get the two-pass build: inventory extraction, then drafting against it', async () => {
    const calls: string[] = [];
    const recording = {
      ...stubProvider(),
      generateText: async (prompt: string) => {
        calls.push(prompt);
        return {
          text: scriptedResponses.shift() ?? '',
          inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'stub', provider: 'stub',
        };
      },
    } as any;
    scriptedResponses.push('- verifies repos are active\n- never recommends unverified sources\n- prefers depth over volume');
    scriptedResponses.push(goodTemplate);
    // >4000 chars of raw persona triggers the inventory pass.
    const longRaw = 'I want a research bot. '.repeat(200) + 'It verifies repos are active before recommending, never recommends unverified sources, prefers depth over volume, and reports with a one-line summary.';
    expect(longRaw.length).toBeGreaterThan(4_000);
    const result = await refinePersona(longRaw, 'Research', recording);
    expect(result).toContain('## Standing instructions');
    // Pass 1 = extraction, pass 2 = draft carrying the inventory checklist.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('checklist');
    expect(calls[1]).toContain('Requirements inventory');
    expect(calls[1]).toContain('verifies repos are active');
  });

  it('drops Access grants for paths the user never wrote (no invented permissions)', async () => {
    scriptedResponses.push(`# R

Research.

## Character

Skeptical.

## Standing instructions

- Be skeptical

## Access

- ~/cookies — read
- ~/some/dir — read

## Output

Concise.
`);
    const raw = 'Research bot; may read ~/cookies for cookie context.';
    const result = await refinePersona(raw, 'R', stubProvider());
    // The persona is character-only now: NO Access section survives, not
    // even user-stated grants — those belong in permissions.yaml (the
    // migration folds them there).
    expect(result).not.toContain('## Access');
    expect(result).not.toContain('~/cookies');
    expect(result).toContain('## Standing instructions');
  });

  it('drops the whole Access section when no user-stated grant survives', async () => {
    scriptedResponses.push(`# R

Research.

## Character

Skeptical.

## Standing instructions

- Be skeptical

## Access

- ~/some/dir — read
- /etc — read

## Output

Concise.
`);
    const result = await refinePersona('plain research bot, no special access', 'R', stubProvider());
    expect(result).not.toContain('## Access');
  });

  it('a failing inventory pass falls back to the single-pass build', async () => {
    let calls = 0;
    const flakyInventory = {
      ...stubProvider(),
      generateText: async (prompt: string) => {
        calls++;
        if (prompt.includes('checklist')) throw new Error('HTTP 500');
        return {
          text: goodTemplate,
          inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'stub', provider: 'stub',
        };
      },
    } as any;
    const longRaw = 'Detailed research persona. '.repeat(200) + 'Be skeptical.';
    const result = await refinePersona(longRaw, 'Research', flakyInventory);
    expect(calls).toBe(2);
    expect(result).toContain('# Research');
  });
});
describe('permission tiers (onboarding question backend)', () => {
  it('tiers produce the documented deny lists', () => {
    const m: any = {};
    applyPermissionTier(m, 'readonly');
    expect(m.tools.deny).toContain('run_command');
    expect(m.tools.deny).toContain('write_file');
    applyPermissionTier(m, 'builder');
    expect(m.tools.deny).toContain('run_command');
    expect(m.tools.deny).not.toContain('write_file');
    applyPermissionTier(m, 'operator');
    expect(m.tools.deny).not.toContain('run_command');
    expect(m.tools.deny).toContain('delete_file');
    applyPermissionTier(m, 'full');
    expect(m.tools.deny).toEqual([]);
  });
});
