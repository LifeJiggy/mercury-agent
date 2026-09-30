import type { BaseProvider } from '../providers/base.js';
import { logger } from '../utils/logger.js';

export interface CrewProposal {
  id: string;
  name: string;
  description: string;
  persona: string;
}

/**
 * Fleet auto-onboarding: one LLM call proposes a crew of 3-5 specialists for
 * a lead bot, matched to its domain. CrewAI guidance — small crews (3-6)
 * keep delegation accuracy high; the proposal is only a SUGGESTION: every
 * member still goes through the standard creation path (validation, cap,
 * persona builder) before anything exists.
 *
 * Output is parsed from a strict JSON array; unusable output returns []
 * (non-fatal — the user falls back to the manual path).
 */
export async function proposeCrew(
  leadName: string,
  leadDescription: string,
  leadPersona: string,
  provider: BaseProvider,
  maxCrew = 6,
): Promise<CrewProposal[]> {
  try {
    const result = await provider.generateText(
      `Design the crew for a fleet lead bot. Lead: "${leadName}" — ${leadDescription || 'no description'}.

Lead persona (context for what specialists it needs):
"""
${leadPersona.slice(0, 3000)}
"""

Propose ${Math.min(5, maxCrew)} sub-bots (2-5, no more) that this lead should command. Each must be a DISTINCT specialty the lead would genuinely delegate to (research, writing, monitoring, development, analysis...). Output ONLY a JSON array, no preamble, no code fences:
[
  {
    "id": "short-lowercase-id-with-dashes",
    "name": "Display Name",
    "description": "One-line specialty",
    "persona": "Full persona text (80-250 words): who it is, how it works, how it reports. Character, standing instructions, output expectations."
  }
]`,
      'You design focused, non-overlapping agent teams. Return ONLY the JSON array.',
    );
    const text = (result.text ?? '').trim().replace(/^```(?:json)?\n?|\n?```$/g, '');
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1) return [];
    const parsed = JSON.parse(text.slice(start, end + 1)) as CrewProposal[];
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed
      .filter(p => {
        if (!p || typeof p.id !== 'string' || typeof p.name !== 'string') return false;
        if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(p.id)) return false;
        if (!p.persona || p.persona.length < 20) return false;
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      })
      .slice(0, maxCrew)
      .map(p => ({
        id: p.id,
        name: p.name.slice(0, 48),
        description: (p.description ?? '').slice(0, 200),
        persona: p.persona,
      }));
  } catch (err: any) {
    logger.warn({ leadName, err: err?.message }, 'Fleet crew proposal failed — falling back to manual');
    return [];
  }
}