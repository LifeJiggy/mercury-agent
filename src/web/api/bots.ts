import { Hono } from 'hono';
import type { BotManager } from '../../bots/bot-manager.js';
import type { BotManifest } from '../../bots/types.js';

const app = new Hono();

let botManager: BotManager | undefined;
let webhookSecret: string | undefined;

export function setBotManager(bm: BotManager | undefined): void {
  botManager = bm;
}

/** Shared secret for bot webhook ingress; unset = auth via the web session only. */
export function setBotsWebhookSecret(secret: string | undefined): void {
  webhookSecret = secret;
}

// Fleet roster with live states
app.get('/api/bots', (c: any) => {
  if (!botManager) {
    return c.json({ bots: [], available: false });
  }
  return c.json({ bots: botManager.getStatusSummaries(), queue: botManager.queue.counts(), available: true });
});

// Onboard a bot
app.post('/api/bots', async (c: any) => {
  if (!botManager) {
    return c.json({ error: 'Bots not available' }, 400);
  }
  const body = await c.req.json().catch(() => null) as
    { id?: string; name?: string; description?: string; persona?: string; manifest?: Partial<BotManifest> } | null;
  if (!body?.id || !body?.name) {
    return c.json({ error: 'id and name are required' }, 400);
  }
  try {
    const manifest = botManager.store.create({
      id: body.id,
      name: body.name,
      description: body.description,
      persona: body.persona,
      manifest: body.manifest,
    });
    botManager.invalidateRuntime(manifest.id);
    return c.json({ bot: manifest }, 201);
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Failed to create bot' }, 400);
  }
});

// Single bot detail (manifest + live state + journal tail)
app.get('/api/bots/:id', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  let manifest;
  try {
    manifest = botManager.store.get(id);
  } catch {
    return c.json({ error: 'Bot not found' }, 404);
  }
  if (!manifest) return c.json({ error: 'Bot not found' }, 404);
  const summary = botManager.getStatusSummaries().find(s => s.id === id) ?? null;
  return c.json({
    bot: manifest,
    state: summary,
    journal: botManager.getJournal(id, 10),
    inbox: botManager.peekMailbox(id),
  });
});

// Patch config (enable/disable, model, tools, memory, comms, schedules)
app.patch('/api/bots/:id', async (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  const patch = await c.req.json().catch(() => null) as Partial<BotManifest> | null;
  if (!patch) return c.json({ error: 'Invalid JSON body' }, 400);
  try {
    const updated = botManager.store.update(id, m => {
      // Only config-editable fields; id/name identity fields are immutable here.
      if (patch.enabled !== undefined) m.enabled = patch.enabled;
      if (patch.description !== undefined) m.description = patch.description;
      if (patch.model !== undefined) m.model = patch.model;
      if (patch.tools !== undefined) m.tools = patch.tools;
      if (patch.memory !== undefined) m.memory = patch.memory;
      if (patch.comms !== undefined) m.comms = patch.comms;
      if (patch.schedules !== undefined) m.schedules = patch.schedules;
      if (patch.autonomy !== undefined) m.autonomy = patch.autonomy;
      if (patch.retention !== undefined) m.retention = patch.retention;
    });
    botManager.invalidateRuntime(id);
    return c.json({ bot: updated });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Failed to update bot' }, 400);
  }
});

// Message a bot (durable enqueue; returns the job id immediately)
app.post('/api/bots/:id/message', async (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { message?: string; from?: string } | null;
  if (!body?.message) return c.json({ error: 'message is required' }, 400);
  const result = botManager.enqueue(id, { trigger: 'api', prompt: body.message, fromBot: body.from });
  if (!result.accepted) {
    return c.json({ accepted: false, reasonCode: result.reasonCode }, 409);
  }
  return c.json({ accepted: true, jobId: result.jobId, status: 'accepted' }, 202);
});

// Inbox (pending bot-to-bot mail)
app.get('/api/bots/:id/inbox', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  return c.json({ inbox: botManager.peekMailbox(c.req.param('id')) });
});

// Run journal
app.get('/api/bots/:id/journal', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const limit = parseInt(c.req.query('limit') ?? '20', 10);
  return c.json({ journal: botManager.getJournal(c.req.param('id'), limit) });
});

// Dead-letter queue + replay
app.get('/api/bots/:id/dlq', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  return c.json({ dlq: botManager.getDlq(c.req.param('id')) });
});

app.post('/api/bots/:id/replay/:jobId', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const result = botManager.replayDlq(c.req.param('id'), c.req.param('jobId'));
  if (!result.accepted) return c.json(result, 404);
  return c.json({ ...result, status: 'accepted' });
});

// Enable/disable/stop/start controls
app.post('/api/bots/:id/enable', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  try {
    botManager.setEnabled(c.req.param('id'), true);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err?.message }, 400);
  }
});

app.post('/api/bots/:id/disable', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  try {
    botManager.setEnabled(c.req.param('id'), false);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err?.message }, 400);
  }
});

app.post('/api/bots/:id/stop', async (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const result = await botManager.stop(c.req.param('id'));
  return c.json({ ok: true, halted: result.halted, heldJobs: result.heldJobs, message: haltedMessage(result) });
});

app.post('/api/bots/:id/start', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  try {
    const result = botManager.start(c.req.param('id'));
    return c.json({ ok: true, resumed: result.resumed, message: result.resumed > 0 ? `Resumed ${result.resumed} held job(s)` : 'Nothing held — bot is ready' });
  } catch (err: any) {
    return c.json({ error: err?.message }, 404);
  }
});

// Fire a routine now (body { routine }) or send a bare wake turn
app.post('/api/bots/:id/run', async (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const body = await c.req.json().catch(() => null) as { routine?: string } | null;
  const result = botManager.runNow(c.req.param('id'), body?.routine);
  if (!result.accepted) return c.json(result, result.reasonCode === 'routine_unknown' ? 404 : 409);
  return c.json({ ...result, status: 'accepted' }, 202);
});

// Fleet views: crew roster of a lead + add-crew
app.get('/api/bots/:id/crew', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  if (!botManager.store.isLead(id)) return c.json({ error: 'Not a fleet lead' }, 400);
  return c.json({
    lead: botManager.store.get(id),
    crew: botManager.store.crewOf(id),
    maxCrew: botManager.maxCrew(),
  });
});

app.post('/api/bots/:id/crew', async (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { id?: string; name?: string; description?: string; persona?: string } | null;
  if (!body?.id || !body?.name) return c.json({ error: 'id and name are required' }, 400);
  const result = botManager.addCrew(id, { id: body.id, name: body.name, description: body.description, persona: body.persona });
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ bot: result.manifest }, 201);
});

function haltedMessage(result: { halted: boolean; heldJobs: number }): string {
  const base = result.halted ? 'Halt signal sent' : 'Nothing running';
  return result.heldJobs > 0 ? `${base}; ${result.heldJobs} queued job(s) held` : base;
}

// Storage view
app.get('/api/bots-storage', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  return c.json({ usage: botManager.getStorage(), queue: botManager.queue.counts() });
});

// Delete a bot entirely (profile dir removed)
app.delete('/api/bots/:id', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  try {
    void botManager.halt(id);
    botManager.store.delete(id);
    botManager.invalidateRuntime(id);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err?.message }, 400);
  }
});

// Generic webhook ingress: validate → dedupe → durable enqueue, ack fast
// (BOTS-ARCHITECTURE §2.3). Callers: external systems pushing events into a
// bot (e.g. an RSS monitor or CI pipeline waking the researcher bot).
app.post('/api/bots/:id/hooks/:hook', async (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  // Auth: shared secret header when configured (webhook callers have no
  // browser session); otherwise the normal authGuard already applied.
  if (webhookSecret) {
    const provided = c.req.header('x-mercury-hook-secret');
    if (provided !== webhookSecret) {
      return c.json({ error: 'Invalid hook secret' }, 401);
    }
  }
  let text: string;
  if (contentTypeIsJson(c.req.header('content-type'))) {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
    text = typeof body.text === 'string' ? body.text : JSON.stringify(body);
  } else {
    text = await c.req.text();
  }
  if (!text.trim()) return c.json({ error: 'Empty payload' }, 400);
  // Idempotency: an explicit event id joins the prompt, so the queue's
  // idempotency key dedupes redeliveries of the same event.
  const eventId = c.req.header('x-event-id');
  const prompt = eventId ? `[hook:${c.req.param('hook')}:${eventId}] ${text}` : `[hook:${c.req.param('hook')}] ${text}`;
  const result = botManager.enqueue(id, { trigger: 'api', prompt });
  if (!result.accepted) {
    return c.json({ accepted: false, reasonCode: result.reasonCode }, 409);
  }
  return c.json({ accepted: true, jobId: result.jobId, status: 'accepted' }, 202);
});

function contentTypeIsJson(value: string | undefined): boolean {
  return (value ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
}

export default app;