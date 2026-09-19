import type { BaseProvider } from '../providers/base.js';
import { logger } from '../utils/logger.js';
import { parsePersonaAccess } from './persona-access.js';

export interface PersonaRefinement {
  /** Refined persona (template format), or null when unusable. */
  text: string | null;
}

/** Hard cap on accepted raw persona text (big personas are legitimate). */
const RAW_CAP = 24_000;
/** Above this length the build is two-pass: extract a requirements inventory
 * first, then draft against it — a single call over a long persona would
 * summarize details away, and every dropped rule is a silent behavior change. */
const INVENTORY_THRESHOLD = 4_000;
const MIN_OUTPUT = 80;
const MAX_OUTPUT = 20_000;

/**
 * Persona builder — turn a user's free-form persona text into the structured
 * format that produces good bot behavior (Character / Standing instructions /
 * Output, the same sections as the onboarding template). Long personas get an
 * extra LLM pass: the first call extracts an exhaustive inventory of the
 * user's requirements, the second drafts the template file against that
 * checklist, so nothing the user wrote is lost in compression.
 *
 * Hard rule: the builder only RESTRUCTURES. It may not add capabilities,
 * permissions, or instructions the user didn't give — an LLM quietly widening
 * a bot's mandate would be a silent privilege grant.
 */
export async function refinePersona(raw: string, botName: string, provider: BaseProvider): Promise<string | null> {
  const source = raw.slice(0, RAW_CAP);
  try {
    let inventory: string | null = null;
    if (source.length > INVENTORY_THRESHOLD) {
      inventory = await extractInventory(source, botName, provider);
      // Inventory failure is non-fatal — fall back to the single-pass build.
    }
    return await draftPersona(source, inventory, botName, provider);
  } catch (err: any) {
    logger.warn({ botName, err: err?.message }, 'Persona refinement failed — keeping raw persona');
    return null;
  }
}

/** Pass 1 (long personas): exhaustive requirement checklist from the raw text. */
async function extractInventory(source: string, botName: string, provider: BaseProvider): Promise<string | null> {
  try {
    const result = await provider.generateText(
      `Extract an exhaustive checklist of requirements from this free-form bot persona. Bot name: ${botName}.

One bullet per distinct requirement, rule, restriction, preference, tone note, output expectation, or fact about the bot. Include EVERYTHING the text states — nothing may be dropped or merged away. No preamble, no numbering, no sections — just the bullets.

"""
${source}
"""`,
      'You extract complete requirement checklists. Return ONLY the bullet list.',
    );
    const text = (result.text ?? '').trim();
    if (!text.includes('-') || text.length < 20) return null;
    return text;
  } catch (err: any) {
    logger.warn({ botName, err: err?.message }, 'Persona inventory extraction failed — drafting without it');
    return null;
  }
}

/** Pass 2: draft the template persona (single-pass when the raw text is short). */
async function draftPersona(source: string, inventory: string | null, botName: string, provider: BaseProvider): Promise<string | null> {
  const result = await provider.generateText(
    `Turn this free-form bot persona into a complete, high-grade persona file. Bot name: ${botName}.

User's persona (the ground truth):
"""
${source}
"""
${inventory ? `
Requirements inventory — every item below MUST appear in the draft; these are extracted from the user's text and none may be dropped:
${inventory}
` : ''}
Output ONLY markdown, in exactly this shape:

# ${botName}

<one-sentence identity summary>

## Character

<personality, voice, tone, expertise boundaries — concrete enough to steer the bot>

## Standing instructions

- <one bullet per behavioral requirement from the user's text; include EVERY rule they wrote, and turn vague statements into precise, testable instructions>

## Output

<output format expectations: shape, length, evidence, tone>

## Access

<the bot ALWAYS has its private sandbox workspace and the fleet-shared folder granted automatically — never list those here. This section holds ONLY extra directory access the user EXPLICITLY granted, one bullet per grant, exactly like: \`- ~/some/dir — read\` or \`- ~/other/dir — read, write\` or \`- /usr/local/bin/tool — execute\`. Extract these ONLY from paths + access the user stated; if the user granted nothing beyond the built-in sandboxes, write the single line: Only the bot's built-in sandbox and the fleet-shared folder.>

Rules: keep length proportional to the source material — a rich persona stays rich, never compress requirements away; never invent new capabilities, tools, or permissions; keep stated restrictions verbatim in meaning; the ## Access section may contain ONLY directory access the user stated — never invent paths, and never add write or execute where the user said read; no preamble, no code fences.`,
    'You write precise bot persona files. Restructure only; never add or remove requirements.',
  );
  const text = (result.text ?? '').trim();
  if (
    !text.startsWith('#')
    || text.length < MIN_OUTPUT
    || text.length > MAX_OUTPUT
    || !text.includes('## Character')
    || !text.includes('## Standing instructions')
  ) {
    logger.debug({ botName }, 'Persona refinement produced unusable output — keeping raw');
    return null;
  }
  return sanitizePersonaAccess(text.endsWith('\n') ? text : text + '\n', source);
}

/**
 * Enforce the no-invented-permissions rule on the drafted `## Access`
 * section: a grant whose path the user never wrote (a copied example, a
 * hallucinated path) is removed, and an Access section with no surviving
 * grants is dropped entirely. `self` is always allowed — it is the default.
 */
function sanitizePersonaAccess(draft: string, source: string): string {
  if (!draft.includes('## Access')) return draft;
  const lines = draft.split('\n');
  const start = lines.findIndex(l => /^##\s+Access\b/i.test(l));
  if (start === -1) return draft;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) { end = i; break; }
  }
  const kept: string[] = [];
  for (const line of lines.slice(start, end)) {
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (!bullet) { kept.push(line); continue; }
    const grant = parsePersonaAccess(`## Access\n${line}`)[0];
    const path = grant?.scope ?? '';
    if (!path || path === 'self' || source.includes(path)) {
      kept.push(line);
    }
    // else: dropped — the user never wrote this path
  }
  const section = kept.filter(l => l.trim().length > 0);
  if (section.length <= 1) {
    // No grants survived — drop the empty section entirely.
    return [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n+$/, '') + '\n';
  }
  return [...lines.slice(0, start), ...section, ...lines.slice(end)].join('\n');
}