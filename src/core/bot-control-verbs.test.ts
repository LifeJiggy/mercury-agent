import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const agentSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'agent.ts'), 'utf8');

/**
 * `/bot start <id>` used to fail with "Could not message start:
 * [reason: target_unknown]" — the fleet-control verb was treated as a bot id.
 * The routing contract: a first token that is a fleet-control verb AND
 * resolves to no configured bot is re-routed to the /bots control surface;
 * a bot actually named like a verb always wins (bot resolution first).
 */
describe('/bot <fleet-verb> re-routes to /bots (control on the message slash)', () => {
  it('covers the /bots surface control verbs', () => {
    for (const verb of ['start', 'stop', 'pause', 'enable', 'disable', 'run', 'open', 'send', 'journal', 'inbox', 'budget', 'edit', 'delete', 'replay']) {
      expect(agentSrc).toContain(new RegExp(`'${verb}'`).source);
    }
    expect(agentSrc).toContain('const BOT_CONTROL_VERBS = new Set([');
  });

  it('re-routes only when the verb is NOT a configured bot (bot names win)', () => {
    expect(agentSrc).toMatch(/BOT_CONTROL_VERBS\.has\(rawTarget\) && !this\.botManager\.resolveBotId\(rawTarget\)/s);
    expect(agentSrc).toContain("trimmed.replace(/^\\/bot\\b/, '/bots')");
  });
});