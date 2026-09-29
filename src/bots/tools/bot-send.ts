import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { BotManager, BotSendResult } from '../bot-manager.js';

/**
 * bot_send — fire-and-forget mailbox delivery to a linked bot (Hermes'
 * message_agent semantics: attributed, queued behind the target's active
 * turn, never a blocking nested invocation). With task: true it becomes
 * fleet DELEGATION: the bot executes and its result is returned to the
 * sender's mailbox on completion.
 */
export function createBotSendTool(manager: BotManager, senderBotId: string, canMessage: string[]) {
  const roster = canMessage.length > 0 ? canMessage.join(', ') : '(no bots linked)';
  return tool({
    description:
      `Send a message to another Mercury bot. Delivery is queued — the target bot consumes it on its next turn. ` +
      `You may message: ${roster}. Use this to hand off findings, request research, or coordinate. ` +
      `With task: true you DELEGATE A TASK — the bot works on it and its result is delivered back to your mailbox on completion.`,
    inputSchema: zodSchema(z.object({
      target: z.string().describe('Bot id to message'),
      message: z.string().min(1).max(20000).describe('Message content — be concrete and self-contained'),
      task: z.boolean().optional().describe('true = delegate a TASK: the bot works on it and its result is delivered back to your mailbox when done. false/omit = fire-and-forget message.'),
    })),
    execute: async ({ target, message, task }: { target: string; message: string; task?: boolean }) => {
      if (!canMessage.includes(target)) {
        return `Error: you are not configured to message bot "${target}". Linked bots: ${roster}`;
      }
      if (target === senderBotId) {
        return 'Error: you cannot message yourself.';
      }
      if (task) {
        const result: BotSendResult = manager.dispatchTask(target, senderBotId, message);
        if (!result.accepted) {
          return `Error dispatching task to ${target}: [reason: ${result.reasonCode}]`;
        }
        return `Task dispatched to ${target} (job ${result.jobId}). It runs asynchronously — the result will arrive in your mailbox when done. Check fleet_status to monitor progress.`;
      }
      const result: BotSendResult = manager.sendToBot(target, senderBotId, message);
      if (!result.accepted) {
        return `Error delivering to ${target}: [reason: ${result.reasonCode}]`;
      }
      return `Queued for ${target} (job ${result.jobId}). Delivery is asynchronous — the bot will consume it on its next turn.`;
    },
  });
}