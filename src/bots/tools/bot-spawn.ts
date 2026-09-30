import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { BotManager } from '../bot-manager.js';
import { refinePersona } from '../persona-template.js';
import type { BaseProvider } from '../../providers/base.js';

export interface BotSpawnTools {
  spawn: ReturnType<typeof createSpawnTool>;
  retire: ReturnType<typeof createRetireTool>;
}

/**
 * bot_spawn / bot_retire — a lead bot's team management: create or retire
 * its OWN crew members within the fleet cap. Every action is journaled on
 * the lead (removeCrew) and logged. Created crew get standard fail-closed
 * defaults (own sandbox + shared folder + comms back to the lead); personas
 * run through the persona builder, which cannot invent grants.
 */
export function createBotSpawnTool(manager: BotManager, leadId: string): BotSpawnTools {
  const maxCrew = manager.maxCrew();
  return {
    spawn: createSpawnTool(manager, leadId, maxCrew),
    retire: createRetireTool(manager, leadId),
  };
}

function createSpawnTool(manager: BotManager, leadId: string, maxCrew: number) {
  return tool({
    description:
      `Create a new specialist crew member for your fleet (cap: ${maxCrew}). Give it a short id, a name, a one-line ` +
      `specialty description, and a persona (who it is, how it works). The persona is refined into a structured ` +
      `persona file automatically. The new bot starts with safe default permissions (its own sandbox + the fleet ` +
      `shared folder) and can message you.`,
    inputSchema: zodSchema(z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/).describe('Short lowercase id for the new bot (e.g. "market-research")'),
      name: z.string().min(1).max(48).describe('Display name, e.g. "Market Researcher"'),
      description: z.string().max(200).describe('One-line specialty description'),
      persona: z.string().min(20).max(8000).describe('The bot\'s persona: character, standing instructions, output style'),
    })),
    execute: async ({ id, name, description, persona }: { id: string; name: string; description: string; persona: string }) => {
      const provider = manager.resolveProviderFor(leadId);
      const refined = await refinePersona(persona, name, provider);
      const result = manager.addCrew(leadId, { id, name, description, persona: refined ?? persona });
      if (!result.ok) {
        return `Error: ${result.error}`;
      }
      return `Crew member created: **${name}** (${result.manifest.id}) — fail-closed defaults, comms linked to you, persona ${refined ? 'refined through the persona builder' : 'saved as written'}. Dispatch tasks with bot_send (task: true); its results will arrive in your mailbox.`;
    },
  });
}

function createRetireTool(manager: BotManager, leadId: string) {
  return tool({
    description:
      'Retire one of your OWN crew members (you can only retire bots you lead). Its profile, sandbox, and queue are removed permanently.',
    inputSchema: zodSchema(z.object({
      id: z.string().describe('The crew bot id to retire'),
    })),
    execute: async ({ id }: { id: string }) => {
      const result = await manager.removeCrew(leadId, id);
      if (!result.ok) {
        return `Error: ${result.error}`;
      }
      return `Crew member **${id}** retired. Fleet capacity freed.`;
    },
  });
}