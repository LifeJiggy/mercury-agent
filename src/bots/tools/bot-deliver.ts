import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { BotManager } from '../bot-manager.js';

/**
 * bot_deliver — move a finished artifact out of the bot's writable areas
 * (its private sandbox, or the fleet-shared folder) into the OWNER-CURATED
 * `outputs/<botId>/` zone. Deliverables there are exempt from the retention
 * janitor and land on the owner's machine — a bot should deliver when the
 * artifact is final, then say so in its turn summary.
 *
 * Fail-closed: only files inside the bot's own writable roots travel;
 * anything else is rejected with `outside_sandbox`.
 */
export function createBotDeliverTool(manager: BotManager, botId: string) {
  return tool({
    description:
      `Deliver a final artifact you produced (a report, export, dataset, script…) from your sandbox ` +
      `or the fleet-shared folder to the owner's outputs zone. Deliverables there are protected ` +
      `from automatic cleanup and visible to the owner. Deliver ONCE per artifact — when it is final, not per draft — ` +
      `and mention the delivered filename in your reply.`,
    inputSchema: zodSchema(z.object({
      file: z.string().min(1).max(500).describe(
        'The file to deliver: an absolute path, or a path relative to your sandbox or the fleet-shared folder (e.g. "_shared/report-2026-09-30.md")',
      ),
      saveAs: z.string().max(120).optional().describe(
        'Optional filename to store it as (extension auto-kept). Defaults to the current filename.',
      ),
    })),
    execute: async ({ file, saveAs }: { file: string; saveAs?: string }) => {
      const result = manager.deliver(botId, file, saveAs);
      if (!result.accepted) {
        if (result.reasonCode === 'outside_sandbox') {
          return `Error: ${file} is not a readable file inside your sandbox or the fleet-shared folder.`;
        }
        if (result.reasonCode === 'target_unknown') {
          return `Error: bot profile for "${botId}" is gone.`;
        }
        return `Error: delivering ${file} failed [reason: ${result.reasonCode}]. Keep the file where it is and report the failure in your summary.`;
      }
      return `Delivered to ${result.path} — the owner's outputs zone (protected from automatic cleanup). The source copy has been removed.`;
    },
  });
}