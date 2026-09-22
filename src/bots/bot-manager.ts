import { cpus } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Tool } from 'ai';
import type { MercuryConfig } from '../utils/config.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { TokenBudget } from '../utils/tokens.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { UserMemoryStore } from '../memory/user-memory.js';
import { UserMemoryStore as UserMemoryStoreImpl } from '../memory/user-memory.js';
import { BotStore, BOT_JOURNAL_FILENAME, isValidCronExpression } from './store.js';
import { BotJournal } from './journal.js';
import { BotQueue, idempotencyKeyFor, LEASE_SECONDS, type DurableBotJob } from './queue.js';
import { createBotCapabilityRegistry, filterBotTools } from './registry-factory.js';
import { createBotSendTool } from './tools/bot-send.js';
import { createBotScheduleTool, type BotScheduler } from './tools/bot-schedule.js';
import { createFleetStatusTool } from './tools/fleet-status.js';
import { createBotSpawnTool } from './tools/bot-spawn.js';
import { runBotTurn, isTransientFailure, type BotTurnMail } from './bot-turn.js';
import { synthesizeSkill, MIN_TOOLS_FOR_SYNTHESIS } from './skill-synthesis.js';
import { SkillLoader } from '../skills/loader.js';
import { logger } from '../utils/logger.js';
import type {
  BotLiveState,
  BotManifest,
  BotRunRecord,
  BotStatusSummary,
  BotTrigger,
} from './types.js';

export interface BotJob {
  id: string;
  botId: string;
  trigger: BotTrigger;
  prompt: string;
  /** Mailbox attribution — set for bot-to-bot deliveries. */
  fromBot?: string;
  /** Originating surface for completion delivery. */
  source?: { channelType: string; channelId: string };
  createdAt: number;
  attempts: number;
}

/**
 * Fleet delegation rule: a mailbox job WITH a prompt (fromBot set) is a TASK
 * dispatched by another bot — its result is returned to the sender's mailbox
 * on completion. Plain mail wakes (prompt '') never reply — no ping-pong.
 * Derived from the job itself, so it survives restarts with zero schema.
 */
function replyTargetFor(job: BotJob): string | undefined {
  return job.trigger === 'mailbox' && job.fromBot && job.prompt ? job.fromBot : undefined;
}

export interface BotSendResult {
  accepted: boolean;
  jobId?: string;
  reasonCode?: 'target_disabled' | 'target_unknown' | 'queue_full' | 'not_linked';
}

export interface BotManagerDeps {
  config: MercuryConfig;
  providers: ProviderRegistry;
  tokenBudget: TokenBudget;
  store?: BotStore;
  /** Durable job store; defaults to the SQLite→JSON backend at the bots root. */
  queue?: BotQueue;
  /** Per-bot memory factory (P0-5 wires the default: UserMemoryStore with bot:<id> key). */
  userMemoryFactory?: (botId: string, manifest: BotManifest) => UserMemoryStore | null;
  /** Global (native) skills root; default resolves to <botsRoot>/../skills (~/.mercury/skills). */
  skillsRoot?: string;
  /** Deliver turn output to the invoking surface (chat/telegram/api). */
  notify?: (channelType: string, channelId: string, message: string) => Promise<void>;
}

const MAX_TRANSIENT_ATTEMPTS = 3;
const MAILBOX_CAPACITY = 100;

/** Bare wake turn (`/bots run <id>` with no routine): the bot gets a real
 * turn with no task attached — it checks its mailbox and standing work. */
const WAKE_PROMPT = '[wake] You were triggered manually with no specific task attached. Check your mailbox and any pending work; act on whatever your persona or standing routines call for, otherwise reply with a one-line status.';

/** Structural subset of the main Scheduler the bot runtime needs. */
type BotSchedulerLike = {
  addDelayedTask(m: { id: string; description: string; prompt: string; delaySeconds?: number; executeAt?: string; botId?: string; createdAt: string }): void;
  addPersistedTask(m: { id: string; cron: string; description: string; prompt: string; botId?: string; createdAt: string }): void;
  persistSchedules(): void;
  getManifests(): Array<{ id: string; botId?: string }>;
  removeTask(id: string): void;
};

/**
 * Owns the bot fleet: per-bot job queues, isolated turn runtimes, mailboxes,
 * run journals, and live statuses. Bots never touch Agent.processQueue —
 * they run as independent coroutines in this manager (BOTS-ARCHITECTURE.md §2.2).
 */
export class BotManager {
  readonly store: BotStore;
  readonly queue: BotQueue;
  private readonly config: MercuryConfig;
  private readonly providers: ProviderRegistry;
  private readonly tokenBudget: TokenBudget;
  private readonly userMemoryFactory?: BotManagerDeps['userMemoryFactory'];
  private readonly skillsRoot?: BotManagerDeps['skillsRoot'];
  private notify?: BotManagerDeps['notify'];
  private alert?: (message: string) => Promise<void>;

  /** Deliver turn output to the invoking surface (wired by the Agent). */
  setNotify(cb: NonNullable<BotManagerDeps['notify']>): void {
    this.notify = cb;
  }

  /** Push needs-you events (permanent failure, budget pause) to the owner. */
  setAlert(cb: (message: string) => Promise<void>): void {
    this.alert = cb;
  }

  /** Wire the main Scheduler so bots can self-schedule (bot_schedule tool). */
  setScheduler(scheduler: BotSchedulerLike): void {
    this.scheduler = scheduler;
    // Runtime-created toolsets gain the tool on next invalidation; simplest
    // is to refresh all bot runtimes so every bot sees the new tool.
    for (const botId of [...this.registries.keys()]) this.invalidateRuntime(botId);
  }

  private async alertOwner(botId: string, message: string): Promise<void> {
    // Needs-you events (permanent failure, budget pause) live in the BOT'S
    // OWN thread — the main chat is never informed (§3.1). Remote owner
    // surfaces (signal/telegram/…) still get the heads-up via the alert
    // channel; the CLI is excluded there (agent wiring) because it would
    // print into whatever main session is open.
    if (this.notify) {
      await this.notify('cli', `bot:${botId}`, message).catch((e) =>
        logger.warn({ e, botId }, 'Bot alert to bot thread failed'));
    }
    if (this.alert) {
      await this.alert(message).catch((e) => logger.warn({ e, botId }, 'Bot alert send failed'));
    }
  }

  private queues: Map<string, BotJob[]> = new Map();
  private scheduler?: BotSchedulerLike;
  private mailboxes: Map<string, BotTurnMail[]> = new Map();
  private running: Map<string, Set<string>> = new Map(); // botId → running job ids
  private aborts: Map<string, AbortController> = new Map(); // job key → controller
  private registries: Map<string, { registry: CapabilityRegistry; tools: Record<string, Tool>; skillsPrompt: string }> = new Map();
  private activity: Map<string, string> = new Map(); // botId → current activity
  private lastRun: Map<string, { at: number; state: BotRunRecord['state'] }> = new Map();
  private needsYou: Set<string> = new Set();
  private journals: Map<string, BotJournal> = new Map();
  private userMemories: Map<string, UserMemoryStore | null> = new Map();
  private disabled = new Set<string>();
  /** Bots stopped by the user (/bots stop) — their held jobs must not sneak
   * back in via the passive due-sweep; only /bots start (or a restart) resumes. */
  private held = new Set<string>();
  /** Per-bot daily token usage: botId → { day (UTC yyyy-mm-dd), tokens }. */
  private dailyTokens: Map<string, { day: string; tokens: number }> = new Map();
  private pausedForBudget = new Set<string>();

  constructor(deps: BotManagerDeps) {
    this.config = deps.config;
    this.providers = deps.providers;
    this.tokenBudget = deps.tokenBudget;
    this.userMemoryFactory = deps.userMemoryFactory ?? ((botId, manifest) => {
      // Default: per-bot namespace in the shared second-brain DB.
      // scope 'none' = stateless bot. SQLite-less devices degrade to a
      // stateless bot until the sql.js/JSONL fallback lands (P1, §2.11).
      const scope = manifest.memory?.scope ?? 'own';
      if (scope === 'none') return null;
      try {
        return new UserMemoryStoreImpl(this.config, `bot:${botId}`);
      } catch (err: any) {
        logger.warn({ botId, err: err?.message }, 'Bot memory store unavailable (no native SQLite) — running stateless');
        return null;
      }
    });
    this.notify = deps.notify;
    this.store = deps.store ?? new BotStore();
    this.skillsRoot = deps.skillsRoot;
    this.queue = deps.queue ?? new BotQueue(this.store.botsRoot, this.config.bots?.retention?.dlqCap);
    // Resume work a crashed predecessor left behind: pending jobs (and
    // expired-lease claimed jobs) re-enter the in-memory queues. Durable
    // enqueue happens before any ack, so nothing was lost (§2.6).
    for (const job of this.queue.resumeJobs()) {
      if (this.store.exists(job.botId)) {
        const q = this.queues.get(job.botId) ?? [];
        this.queues.set(job.botId, q);
        q.push({
          id: job.id, botId: job.botId, trigger: job.trigger, prompt: job.prompt,
          fromBot: job.fromBot, source: job.source, createdAt: job.createdAt, attempts: job.attempts,
        });
        this.pump(job.botId);
      } else {
        this.queue.settle(job.id, 'dead', 'bot_removed');
      }
    }
    // Durable mailboxes survive restarts: rehydrate into the in-memory boxes.
    for (const m of this.store.list()) {
      const drained = this.queue.drainMail(m.id);
      if (drained.length > 0) this.mailboxes.set(m.id, drained);
    }
    // Periodic due-sweep: retry-backoff jobs re-enter the in-memory queues
    // when their run_after elapses (also covers crash-restart backoffs).
    const dueTimer = setInterval(() => this.resumeDueJobs(), 30_000);
    dueTimer.unref?.();
  }

  /** Pull due (backoff-elapsed) jobs from the durable queue into memory and run them. */
  private resumeDueJobs(): void {
    const due = this.queue.dueJobs();
    for (const job of due) {
      if (this.disabled.has(job.botId) || this.held.has(job.botId)) continue;
      const running = this.running.get(job.botId)?.size ?? 0;
      const q = this.queues.get(job.botId) ?? [];
      const alreadyQueued = q.some(j => j.id === job.id);
      if (!alreadyQueued && running === 0) {
        q.push({
          id: job.id, botId: job.botId, trigger: job.trigger, prompt: job.prompt,
          fromBot: job.fromBot, source: job.source, createdAt: job.createdAt, attempts: job.attempts,
        });
        this.queues.set(job.botId, q);
        this.pump(job.botId);
      }
    }
  }

  /** Fleet-wide concurrency cap: config override or clamp(2, cpus-1). */
  private fleetCap(): number {
    const configured = this.config.bots?.maxConcurrent ?? 0;
    if (configured > 0) return configured;
    return Math.max(2, Math.min(cpus().length - 1, 8));
  }

  private journalFor(botId: string): BotJournal {
    let j = this.journals.get(botId);
    if (!j) {
      const manifest = this.store.get(botId);
      const retention = { ...(this.config.bots?.retention ?? {}), ...(manifest?.retention ?? {}) };
      j = new BotJournal(this.store.botDir(botId), retention.journalRotateBytes, retention.journalKeepRotations);
      this.journals.set(botId, j);
    }
    return j;
  }

  private getOrCreateJournal(botId: string): BotJournal {
    return this.journalFor(botId);
  }

  enqueue(botId: string, job: { trigger: BotTrigger; prompt: string; fromBot?: string; source?: { channelType: string; channelId: string }; attempts?: number }): { jobId: string; accepted: boolean; reasonCode?: string } {
    const manifest = this.store.get(botId);
    if (!manifest) return { jobId: '', accepted: false, reasonCode: 'target_unknown' };
    if (!manifest.enabled || this.disabled.has(botId)) return { jobId: '', accepted: false, reasonCode: 'target_disabled' };

    const queue = this.queues.get(botId) ?? [];
    this.queues.set(botId, queue);
    if (queue.length >= MAILBOX_CAPACITY) {
      return { jobId: '', accepted: false, reasonCode: 'queue_full' };
    }
    // Durable-before-ack: the job is persisted (idempotency-deduped) before
    // the caller hears "accepted" — a crash between ack and run loses nothing.
    const durable = this.queue.enqueue({
      id: randomUUID().slice(0, 8),
      botId,
      trigger: job.trigger,
      prompt: job.prompt,
      fromBot: job.fromBot,
      source: job.source,
      attempts: job.attempts ?? 0,
      createdAt: Date.now(),
      idempotencyKey: idempotencyKeyFor(botId, job.trigger, job.prompt, job.fromBot),
    });
    if (durable.duplicated) {
      return { jobId: durable.job.id, accepted: true };
    }
    const id = durable.job.id;
    queue.push({ id, botId, trigger: job.trigger, prompt: job.prompt, fromBot: job.fromBot, source: job.source, createdAt: durable.job.createdAt, attempts: durable.job.attempts });
    this.pump(botId);
    return { jobId: id, accepted: true };
  }

  /**
   * Fleet task dispatch: a delegated TASK from one bot to another (lead →
   * crew, crew → lead). Durable job with the task as the prompt — on
   * completion the result is returned to the sender's mailbox
   * (replyTargetFor), closing the delegation loop.
   */
  dispatchTask(targetBotId: string, fromBot: string, task: string): BotSendResult {
    const result = this.enqueue(targetBotId, { trigger: 'mailbox', prompt: task, fromBot });
    if (!result.accepted) return { accepted: false, reasonCode: result.reasonCode as BotSendResult['reasonCode'] };
    return { accepted: true, jobId: result.jobId };
  }

  /** Fire-and-forget mailbox delivery from another bot. */
  sendToBot(targetBotId: string, fromBot: string, content: string): BotSendResult {
    const manifest = this.store.get(targetBotId);
    if (!manifest) return { accepted: false, reasonCode: 'target_unknown' };
    if (!manifest.enabled || this.disabled.has(targetBotId)) return { accepted: false, reasonCode: 'target_disabled' };

    const box = this.mailboxes.get(targetBotId) ?? [];
    if (box.length >= MAILBOX_CAPACITY) {
      return { accepted: false, reasonCode: 'queue_full' };
    }
    // Durable-before-ack for handoffs too: a bot_send that returns "queued"
    // must survive a crash before the target's next turn drains it.
    this.queue.enqueueMail({ botId: targetBotId, from: fromBot, content, createdAt: Date.now() });
    box.push({ from: fromBot, content });
    this.mailboxes.set(targetBotId, box);

    // If the bot is idle (no running turn, empty job queue), wake it with a
    // mailbox-driven turn so mail is consumed promptly.
    const queue = this.queues.get(targetBotId) ?? [];
    const isRunning = (this.running.get(targetBotId)?.size ?? 0) > 0;
    let jobId: string | undefined;
    if (queue.length === 0 && !isRunning) {
      jobId = randomUUID().slice(0, 8);
      queue.push({ id: jobId, botId: targetBotId, trigger: 'mailbox', prompt: '', createdAt: Date.now(), attempts: 0 });
      this.queues.set(targetBotId, queue);
      this.pump(targetBotId);
    }
    return { accepted: true, jobId };
  }

  /** Poll-and-drain a bot's mailbox (turns); durable rows removed too. */
  drainMailbox(botId: string): BotTurnMail[] {
    const box = this.mailboxes.get(botId) ?? [];
    this.mailboxes.set(botId, []);
    this.queue.drainMail(botId);
    return box;
  }

  peekMailbox(botId: string): BotTurnMail[] {
    return [...(this.mailboxes.get(botId) ?? [])];
  }

  /** Kick the queue: start turns while slots (per-bot and fleet-wide) exist. */
  private pump(botId: string): void {
    const manifest = this.store.get(botId);
    if (!manifest?.enabled || this.disabled.has(botId)) return;
    const today = new Date().toISOString().slice(0, 10);
    const used = this.dailyTokens.get(botId);
    if (used && used.day !== today) {
      this.dailyTokens.delete(botId);
      this.pausedForBudget.delete(botId);
    }
    if (this.pausedForBudget.has(botId)) {
      this.activity.set(botId, 'Paused — daily token budget reached');
      return;
    }
    const queue = this.queues.get(botId) ?? [];
    const running = this.running.get(botId) ?? new Set();
    this.running.set(botId, running);

    const perBotCap = manifest.autonomy?.maxConcurrent ?? 1;

    while (queue.length > 0 && running.size < perBotCap && this.fleetRunningCount() < this.fleetCap()) {
      const job = queue.shift()!;
      void this.executeTurn(job);
    }
  }

  /** Hard daily budget stop: pause (resume next UTC day), never die. */
  private recordBotTokens(botId: string, manifest: BotManifest, tokens: number): void {
    const today = new Date().toISOString().slice(0, 10);
    const entry = this.dailyTokens.get(botId);
    const next = entry && entry.day === today ? entry.tokens + tokens : tokens;
    this.dailyTokens.set(botId, { day: today, tokens: next });
    const cap = manifest.autonomy?.dailyTokenBudget;
    if (cap && next >= cap) {
      this.pausedForBudget.add(botId);
      logger.warn({ botId, used: next, cap }, 'Bot daily token budget reached — pausing until next day');
      void this.alertOwner(botId, `🟡 **${manifest.name}** paused — daily token budget reached (${next} ≥ ${cap}). Resumes tomorrow; raise the cap in bot.yaml if this is too tight.`);
    }
  }

  private fleetRunningCount(): number {
    let total = 0;
    for (const s of this.running.values()) total += s.size;
    return total;
  }

  private async executeTurn(job: BotJob): Promise<void> {
    const { botId } = job;
    const running = this.running.get(botId) ?? new Set();
    this.running.set(botId, running);
    running.add(job.id);
    const controller = new AbortController();
    this.aborts.set(`${botId}:${job.id}`, controller);
    this.activity.set(botId, describeJob(job));

    const manifest = this.store.get(botId);
    if (!manifest) {
      running.delete(job.id);
      return;
    }

    try {
      this.queue.claim(job.id, LEASE_SECONDS);
      const turn = this.buildTurn(botId, manifest, job, controller.signal);
      const output = await runBotTurn(turn.input);
      turn.cleanup();

      const record: BotRunRecord = {
        runId: job.id,
        botId,
        trigger: job.trigger,
        state: output.status === 'completed' ? 'completed' : output.status,
        startedAt: job.createdAt,
        durationMs: Date.now() - job.createdAt,
        tokensIn: output.tokensIn,
        tokensOut: output.tokensOut,
        summary: output.output.slice(0, 300),
        error: output.error,
        reasonCode: output.reasonCode,
      };
      this.journalFor(botId).append(record);
      this.lastRun.set(botId, { at: Date.now(), state: record.state });
      this.needsYou.delete(botId);
      this.recordBotTokens(botId, manifest, output.tokensIn + output.tokensOut);

      // Auto-skill synthesis (P2-3): a completed multi-step run is a
      // procedure worth keeping. Fire-and-forget, gated by config.
      if (
        output.status === 'completed'
        && output.toolsUsed.length >= MIN_TOOLS_FOR_SYNTHESIS
        && (this.config.bots as any)?.autoSkill?.enabled
      ) {
        void synthesizeSkill({
          botId,
          botName: manifest.name,
          prompt: job.prompt,
          output: output.output,
          toolsUsed: output.toolsUsed,
          provider: resolveProvider(this.providers, manifest),
          // The synthesized skill lands in the BOT'S OWN library (draft:true),
          // not the global root — it is that bot's learned procedure, usable
          // by it on the next run (runtime invalidated on success).
          skillsRoot: this.store.skillsDir(botId),
        }).then((synth) => { if (synth) this.invalidateRuntime(botId); })
          .catch((err) => logger.warn({ err, botId }, 'Skill synthesis failed'));
      }

      // Transient provider failures retry with backoff, bounded; permanent
      // failures go to the capped DLQ and stop (never silently re-queued — §2.6).
      // Retries requeue the SAME job in place (durable): no settle-then-
      // reenqueue window where a crash would lose the work.
      if (output.status === 'failed' && output.reasonCode && isTransientFailure(output.reasonCode) && job.attempts + 1 < MAX_TRANSIENT_ATTEMPTS) {
        const delay = Math.min(15000, 1000 * 2 ** job.attempts);
        this.queue.retry(job.id, job.attempts + 1, Date.now() + delay);
        logger.info({ botId, jobId: job.id, reasonCode: output.reasonCode, retryIn: delay }, 'Bot turn failed transiently — retrying in place');
        setTimeout(() => {
          const q = this.queues.get(botId) ?? [];
          if (!q.some(j => j.id === job.id)) {
            q.push({ ...job, attempts: job.attempts + 1 });
            this.queues.set(botId, q);
            this.pump(botId);
          }
        }, delay).unref?.();
      } else if (output.status === 'failed') {
        this.queue.settle(job.id, 'dead', output.reasonCode);
        this.needsYou.add(botId);
        logger.warn({ botId, jobId: job.id, reasonCode: output.reasonCode }, 'Bot turn failed permanently — moved to DLQ (replayable via /bots dlq)');
        await this.alertOwner(botId, `❌ **${manifest.name}** failed permanently [reason: ${output.reasonCode}] — replay with \`/bots replay ${botId} ${job.id}\``);
      } else if (output.status === 'paused') {
        // Step-budget pause: work continues next turn — same job requeues in
        // place (durable), no attempts bump.
        this.queue.retry(job.id, job.attempts, Date.now() + 2000);
        setTimeout(() => {
          const q = this.queues.get(botId) ?? [];
          if (!q.some(j => j.id === job.id)) {
            q.push({ ...job });
            this.queues.set(botId, q);
            this.pump(botId);
          }
        }, 2000).unref?.();
      } else {
        this.queue.settle(job.id, 'done');
      }

      // Deliver the outcome — the bot thread is the ONLY local surface
      // (BOTS-ARCHITECTURE §3.1): the FULL result lands in the BOT'S OWN
      // thread and the CLI session that asked is NOT notified at all — a
      // pointer into the main chat would leak into whatever session is open
      // days later (a routine or retry finishing inside a brand-new session
      // printed bot traffic into the user's regular chat/code). Remote
      // channels (Telegram/web) stay the exception: their user cannot open
      // bot threads, so the full result is delivered in that chat. Halts
      // report too (a stopped run must announce it stopped, §2.6).
      if (this.notify && job.trigger !== 'mailbox') {
        const botThread = `bot:${botId}`;
        const icon = output.status === 'completed' ? '🤖' : output.status === 'failed' ? '❌' : output.status === 'halted' ? '⏹' : '⏸';
        const fullText = output.status === 'halted'
          ? `⏹ Run ${job.id} was stopped by you — no further output. It is recorded in \`/bots journal ${botId}\`.`
          : `${icon} (${job.trigger}): ${output.output.slice(0, 800)}`;
        // 1. Full result → the bot's own thread, always.
        await this.notify('cli', botThread, fullText).catch((e) =>
          logger.warn({ e, botId }, 'Bot result deliver to bot thread failed'));
        // 2. Remote requesting surface only — no CLI pointer, no main-chat
        // traffic, ever.
        const sourceChannelType = job.source?.channelType ?? 'cli';
        const sourceChannelId = job.source?.channelId;
        if (sourceChannelId && sourceChannelId !== botThread && sourceChannelType !== 'cli') {
          await this.notify(sourceChannelType, sourceChannelId, fullText).catch((e) =>
            logger.warn({ e, botId }, 'Bot remote-channel result notify failed'));
        }
      }

      // Fleet delegation loop: a task dispatched by another bot reports its
      // result back to the sender's mailbox (attributed, plain mail — never a
      // task, so results can't ping-pong). Paused runs requeue and report
      // later; the failure/retry machinery above owns transient states.
      const replyTarget = replyTargetFor(job);
      if (replyTarget && (output.status === 'completed' || output.status === 'failed' || output.status === 'halted')) {
        const icon = output.status === 'completed' ? '✅' : output.status === 'failed' ? '❌' : '⏹';
        const reply = output.status === 'completed'
          ? `✅ Task complete (job ${job.id}):\n${output.output.slice(0, 4000)}`
          : output.status === 'failed'
            ? `❌ Task FAILED (job ${job.id})${output.reasonCode ? ` [reason: ${output.reasonCode}]` : ''}: ${(output.error ?? output.output).slice(0, 1000)}`
            : `⏹ Task halted (job ${job.id}) — it was stopped; see /bots journal ${botId}.`;
        const sent = this.sendToBot(replyTarget, botId, reply);
        if (!sent.accepted) {
          logger.warn({ botId, replyTarget, reason: sent.reasonCode }, 'Fleet result reply not delivered');
        }
      }
    } catch (err: any) {
      logger.error({ botId, jobId: job.id, err: err?.message }, 'Bot turn crashed');
      this.queue.settle(job.id, 'dead', 'unknown_error');
      this.needsYou.add(botId);
      void this.alertOwner(botId, `💥 **${botId}** run ${job.id} crashed: ${String(err?.message ?? err).slice(0, 150)} — see journal; replay from DLQ.`);
      this.journalFor(botId).append({
        runId: job.id,
        botId,
        trigger: job.trigger,
        state: 'failed',
        startedAt: job.createdAt,
        durationMs: Date.now() - job.createdAt,
        tokensIn: 0,
        tokensOut: 0,
        error: err?.message,
        reasonCode: 'unknown_error',
      });
      this.needsYou.add(botId);
    } finally {
      running.delete(job.id);
      this.aborts.delete(`${botId}:${job.id}`);
      if (running.size === 0) this.activity.delete(botId);
      this.pump(botId);
    }
  }

  private userMemoryFor(botId: string, manifest: BotManifest): UserMemoryStore | null {
    if (this.userMemories.has(botId)) return this.userMemories.get(botId) ?? null;
    const factory = this.userMemoryFactory;
    if (!factory) return null;
    let store: UserMemoryStore | null = null;
    try {
      store = factory(botId, manifest);
    } catch (err: any) {
      // Memory is an enhancement, never a hard dependency — a store that
      // fails to build (e.g. no native SQLite) degrades to a stateless bot.
      logger.warn({ botId, err: err?.message }, 'Bot memory store build failed — running stateless');
    }
    this.userMemories.set(botId, store);
    return store;
  }

  private buildTurn(botId: string, manifest: BotManifest, job: BotJob, signal: AbortSignal): { input: Parameters<typeof runBotTurn>[0]; cleanup: () => void } {
    const { registry, tools, skillsPrompt } = this.getOrCreateRuntime(botId, manifest);
    const userMemory = this.userMemoryFor(botId, manifest);

    const mail: BotTurnMail[] = [];
    // Deliveries from other bots arrive via the mailbox; drain at turn start.
    const pending = this.drainMailbox(botId);
    mail.push(...pending);

    return {
      input: {
        manifest,
        trigger: job.trigger,
        prompt: job.prompt,
        persona: this.store.readPersona(botId),
        mail,
        pollMail: () => this.drainMailbox(botId),
        sandbox: { workspace: this.store.sandboxDir(botId), shared: this.store.sharedSandboxDir() },
        skillsPrompt,
        fleet: this.fleetContext(botId, manifest),
        capabilities: registry,
        tools,
        userMemory,
        provider: resolveProvider(this.providers, manifest),
        tokenBudget: this.tokenBudget,
        abortSignal: signal,
      },
      cleanup: () => { /* per-bot registries are persistent, nothing to restore */ },
    };
  }

  /** Fleet context for the turn prompt (undefined for solo bots). */
  private fleetContext(botId: string, manifest: BotManifest) {
    if (manifest.fleetRole === 'lead') {
      return {
        role: 'lead' as const,
        leadName: manifest.parent ? this.store.get(manifest.parent)?.name : undefined,
        crew: this.store.crewOf(botId).map(c => ({
          id: c.id,
          name: c.name,
          description: c.description,
          state: this.getStatusSummaries().find(s => s.id === c.id)?.state ?? 'idle',
        })),
        maxCrew: this.maxCrew(),
      };
    }
    if (manifest.parent) {
      return {
        role: 'crew' as const,
        leadName: this.store.get(manifest.parent)?.name,
        crew: [],
        maxCrew: 0,
      };
    }
    return undefined;
  }

  private getOrCreateRuntime(botId: string, manifest: BotManifest): { registry: CapabilityRegistry; tools: Record<string, Tool>; skillsPrompt: string } {
    const cached = this.registries.get(botId);
    if (cached) return cached as { registry: CapabilityRegistry; tools: Record<string, Tool>; skillsPrompt: string };
    // Skill access: global (native) library + the bot's own skills dir
    // (auto-synthesized + hand-authored; own-dir names win on collision).
    // Default root = <botsRoot>/../skills — ~/.mercury/skills in production,
    // tmp-local in tests.
    let skillLoader: SkillLoader | undefined;
    let skillsPrompt = '';
    try {
      skillLoader = new SkillLoader(this.skillsRoot ?? resolve(this.store.botsRoot, '..', 'skills'), {
        extraDirs: [this.store.skillsDir(botId)],
        seedDefaults: false,
      });
      skillLoader.discover();
      skillsPrompt = skillLoader.getSkillSummariesText();
    } catch (err: any) {
      logger.warn({ botId, err: err?.message }, 'Bot skill loader unavailable — continuing without skills');
    }
    const registry = createBotCapabilityRegistry({
      botId,
      manifest,
      botDir: this.store.botDir(botId),
      permissions: this.store.readPermissions(botId),
      // The persona's `## Access` section grants extra path scopes — read at
      // registry build, so a persona edit (invalidateRuntime on write) applies
      // to the very next turn.
      persona: this.store.readPersona(botId),
      skillLoader,
      // Built-in work areas: private sandbox + fleet-shared folder (rw+x,
      // implicit — no permission ask, no Access declaration).
      sandbox: { workspace: this.store.sandboxDir(botId), shared: this.store.sharedSandboxDir() },
      userMemory: this.userMemoryFor(botId, manifest),
      config: this.config,
    });
    // Filter FIRST (strips interactive/global-mutation tools and applies the
    // manifest allow/deny), THEN add the bot-specific tools — otherwise the
    // filter would strip them again.
    const filtered = filterBotTools({ ...registry.getTools() }, manifest);
    // Fleet relations are implicit comms: a lead can message its crew and a
    // crew bot its lead, without anyone hand-editing canMessage.
    const effectiveRoster = this.effectiveRoster(botId, manifest);
    if (effectiveRoster.length > 0) {
      filtered.bot_send = createBotSendTool(this, botId, effectiveRoster) as Tool;
    }
    // Fleet tools for leads: monitor the crew, spawn/retire within caps.
    if (manifest.fleetRole === 'lead') {
      filtered.fleet_status = createFleetStatusTool(this, botId);
      if (this.config.bots?.fleets?.allowLeadSpawn !== false) {
        const fleet = createBotSpawnTool(this, botId);
        filtered.bot_spawn = fleet.spawn;
        filtered.bot_retire = fleet.retire;
      }
    }
    // bot_schedule: bots can schedule their own future runs (durable,
    // capped) when the main scheduler is wired.
    if (this.scheduler) {
      filtered.bot_schedule = createBotScheduleTool(this.scheduler, botId);
    }
    this.registries.set(botId, { registry, tools: filtered, skillsPrompt });
    return { registry, tools: filtered, skillsPrompt };
  }

  /**
   * Comms roster = explicit canMessage ∪ fleet relations (lead ↔ own crew).
   * Derived per registry build; excludes the bot itself.
   */
  private effectiveRoster(botId: string, manifest: BotManifest): string[] {
    const roster = new Set(manifest.comms?.canMessage ?? []);
    if (manifest.fleetRole === 'lead') {
      for (const crew of this.store.crewOf(botId)) roster.add(crew.id);
    }
    // A mid-level lead (crew of a parent AND lead of its own crew) talks both ways.
    if (manifest.parent) {
      roster.add(manifest.parent);
    }
    roster.delete(botId);
    return [...roster];
  }

  // ---- fleet management (shared by onboarding, lead tools, API) -----------

  /** Max crew per lead — CrewAI guidance: 3-6 for delegation accuracy. */
  maxCrew(): number {
    return this.config.bots?.fleets?.maxCrew ?? 6;
  }

  /** The bot's provider (public for fleet tools — persona building on spawn). */
  resolveProviderFor(botId: string): ReturnType<typeof resolveProvider> {
    const manifest = this.store.get(botId);
    return resolveProvider(this.providers, manifest ?? { id: botId, name: botId, enabled: true } as BotManifest);
  }

  /**
   * Add a crew member to a lead: validates the relationship, enforces the
   * crew cap, creates with fail-closed defaults + comms back to the lead.
   * Persona refinement (builder) is the caller's concern (async provider
   * call); addCrew writes the persona text it is given.
   */
  addCrew(leadId: string, spec: { id: string; name: string; description?: string; persona?: string }): { ok: true; manifest: BotManifest } | { ok: false; error: string } {
    const lead = this.store.get(leadId);
    if (!lead) return { ok: false, error: `No bot "${leadId}"` };
    if (lead.fleetRole !== 'lead') {
      return { ok: false, error: `**${lead.name}** is not a fleet lead — promote it with \`/bots promote ${leadId}\` first` };
    }
    // Multi-level guard: no cycles, bounded depth (v1 supports 3 levels —
    // e.g. CEO → Engineering Lead → Backend). Walk the lead's parent chain.
    let ancestor: string | undefined = leadId;
    let depth = 0;
    const seen = new Set<string>();
    while (ancestor) {
      if (seen.has(ancestor)) return { ok: false, error: 'Fleet cycle detected in parent chain' };
      seen.add(ancestor);
      if (ancestor === spec.id.toLowerCase()) {
        return { ok: false, error: `Cannot add **${spec.id}** — it would become its own ancestor` };
      }
      ancestor = this.store.get(ancestor)?.parent;
      if (++depth > 3) return { ok: false, error: 'Fleet nesting is capped at 3 levels' };
    }
    const crew = this.store.crewOf(leadId);
    const cap = this.maxCrew();
    if (crew.length >= cap) {
      return { ok: false, error: `Fleet is at the crew cap (${crew.length}/${cap}) — retire a member first or raise BOTS_FLEET_MAX_CREW` };
    }
    if (this.store.exists(spec.id)) {
      return { ok: false, error: `Bot "${spec.id}" already exists` };
    }
    const manifest = this.store.create({
      id: spec.id.toLowerCase(),
      name: spec.name,
      description: spec.description,
      persona: spec.persona,
      manifest: { fleetRole: 'crew', parent: leadId, comms: { canMessage: [leadId] } },
    });
    this.invalidateRuntime(leadId); // lead's roster + fleet prompt change
    logger.info({ leadId, crewId: spec.id }, 'Crew member added to fleet');
    return { ok: true, manifest };
  }

  /** Remove a crew member (lead's own child only) and record it on the lead. */
  async removeCrew(leadId: string, crewId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const crew = this.store.get(crewId);
    if (!crew) return { ok: false, error: `No bot "${crewId}"` };
    if (crew.parent !== leadId) return { ok: false, error: `**${crewId}** is not crew of **${leadId}**` };
    await this.delete(crewId);
    this.invalidateRuntime(leadId);
    this.journalFor(leadId).append({
      runId: randomUUID().slice(0, 8),
      botId: leadId,
      trigger: 'chat',
      state: 'completed',
      startedAt: Date.now(),
      durationMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      summary: `Retired crew member "${crew.name}" (${crewId})`,
    });
    logger.info({ leadId, crewId }, 'Crew member retired');
    return { ok: true };
  }

  invalidateRuntime(botId: string): void {
    this.registries.delete(botId);
  }

  /**
   * Full lifecycle delete: halt, purge durable queue state (jobs/mail/DLQ),
   * remove scheduler routines (zombie cron would fire forever), drop the
   * profile dir, and clear every in-memory cache — so a re-created bot with
   * the same id starts clean (no stale mail or resurrected routines).
   */
  async delete(botId: string): Promise<void> {
    await this.halt(botId);
    // Fleet cleanup: a deleted LEAD's crew is detached (→ solo), never orphaned
    // with a dangling parent. A deleted crew bot just leaves the roster.
    if (this.store.isLead(botId)) {
      for (const crew of this.store.crewOf(botId)) {
        this.store.update(crew.id, m => { m.fleetRole = undefined; m.parent = undefined; });
        this.invalidateRuntime(crew.id);
        logger.info({ leadId: botId, crewId: crew.id }, 'Fleet lead deleted — crew member detached to solo');
      }
    }
    // Scheduler routines (bot:<id>:*) — both bot.yaml routines and
    // bot_schedule self-created ones; they must never fire again.
    if (this.scheduler) {
      for (const m of this.scheduler.getManifests()) {
        if (m.botId === botId) this.scheduler.removeTask(m.id);
      }
      this.scheduler.persistSchedules();
    }
    this.queue.purgeBot(botId);
    this.store.delete(botId);
    this.registries.delete(botId);
    this.journals.delete(botId);
    this.userMemories.delete(botId);
    this.queues.delete(botId);
    this.mailboxes.delete(botId);
    this.dailyTokens.delete(botId);
    this.activity.delete(botId);
    this.lastRun.delete(botId);
    this.needsYou.delete(botId);
    this.pausedForBudget.delete(botId);
    this.held.delete(botId);
    logger.info({ botId }, 'Bot deleted: queue/mail/DLQ purged, routines removed');
  }

  /**
   * Register every enabled bot's cron routines with the main Scheduler
   * (manifest id `bot:<botId>:<name>`). Bot runs fire on the cron lane and
   * route to the bot lane, never through Agent.processQueue. Idempotent:
   * the Scheduler replaces existing tasks by id.
   */
  registerRoutines(scheduler: { addPersistedTask(m: any): void }): void {
    let count = 0;
    for (const manifest of this.store.list()) {
      if (!manifest.enabled) continue;
      for (const routine of manifest.schedules ?? []) {
        if (!isValidCronExpression(routine.cron)) {
          logger.warn({ botId: manifest.id, cron: routine.cron }, 'Invalid cron expression — routine skipped');
          continue;
        }
        scheduler.addPersistedTask({
          id: `bot:${manifest.id}:${routine.name}`,
          cron: routine.cron,
          description: routine.name,
          prompt: routine.prompt,
          botId: manifest.id,
          createdAt: new Date().toISOString(),
        });
        count++;
      }
    }
    if (count > 0) {
      logger.info({ routines: count }, 'Bot routines registered');
    }
  }

  // ---- control plane -------------------------------------------------------

  async halt(botId: string, jobId?: string): Promise<boolean> {
    const running = this.running.get(botId);
    const hadRunning = !!running && running.size > 0;
    for (const id of running ?? []) {
      if (jobId && id !== jobId) continue;
      this.aborts.get(`${botId}:${id}`)?.abort();
    }
    // Queued-but-not-started jobs leave the in-memory lane; their durable rows
    // stay pending, so /bots start (or a restart) can resume them — stop never
    // silently destroys queued work (§2.7 control plane).
    this.queues.set(botId, jobId ? (this.queues.get(botId) ?? []).filter(j => j.id !== jobId) : []);
    return hadRunning;
  }

  async haltAll(): Promise<void> {
    for (const [botId] of this.running) {
      await this.halt(botId);
    }
  }

  /**
   * User-facing stop: abort the running turn(s) AND hold queued work. Held
   * jobs stay durable-pending (survive a restart); the passive due-sweep
   * skips held bots, so nothing resumes until /bots start. Explicit new
   * triggers (send/mail/cron) still work — the bot is stopped, not disabled.
   */
  async stop(botId: string): Promise<{ halted: boolean; heldJobs: number }> {
    const heldJobs = (this.queues.get(botId) ?? []).length;
    const halted = await this.halt(botId);
    this.held.add(botId);
    if (heldJobs > 0) {
      logger.info({ botId, heldJobs }, 'Bot stopped — queued jobs held (resumable via /bots start)');
    }
    return { halted, heldJobs };
  }

  /**
   * User-facing resume (the counterpart of stop): clear the stop-hold,
   * re-enter held/pending durable jobs, and kick the queue. A disabled bot
   * is enabled first — "start" is unambiguous. Safe on an already-running bot.
   */
  start(botId: string): { resumed: number } {
    const manifest = this.store.get(botId);
    if (!manifest) throw new Error(`Bot "${botId}" does not exist`);
    this.held.delete(botId);
    const resumed = this.rehydratePending(botId);
    if (!manifest.enabled || this.disabled.has(botId)) {
      this.setEnabled(botId, true); // persists enabled + pumps
    } else {
      this.pump(botId);
    }
    return { resumed };
  }

  /** Pull durable pending jobs for a bot back into the in-memory queue. */
  private rehydratePending(botId: string): number {
    const pending = this.queue.pendingJobs(botId);
    if (pending.length === 0) return 0;
    const q = this.queues.get(botId) ?? [];
    const running = this.running.get(botId) ?? new Set();
    let added = 0;
    for (const job of pending) {
      if (q.some(j => j.id === job.id) || running.has(job.id)) continue;
      q.push({
        id: job.id, botId, trigger: job.trigger, prompt: job.prompt,
        fromBot: job.fromBot, source: job.source, createdAt: job.createdAt, attempts: job.attempts,
      });
      added++;
    }
    if (added > 0) {
      this.queues.set(botId, q);
      logger.info({ botId, resumed: added }, 'Re-entered pending bot jobs (explicit resume)');
    }
    return added;
  }

  /** Fire a bot's configured routine immediately, or send a bare wake turn. */
  runNow(botId: string, routineName?: string): { accepted: boolean; jobId?: string; reasonCode?: string } {
    const manifest = this.store.get(botId);
    if (!manifest) return { accepted: false, reasonCode: 'target_unknown' };
    if (routineName) {
      const routine = (manifest.schedules ?? []).find(r => r.name.toLowerCase() === routineName.toLowerCase());
      if (!routine) return { accepted: false, reasonCode: 'routine_unknown' };
      return this.enqueue(botId, { trigger: 'cron', prompt: routine.prompt });
    }
    return this.enqueue(botId, { trigger: 'chat', prompt: WAKE_PROMPT });
  }

  setEnabled(botId: string, enabled: boolean): void {
    if (enabled) {
      this.disabled.delete(botId);
      this.store.setEnabled(botId, true);
      this.pump(botId);
    } else {
      this.disabled.add(botId);
      void this.halt(botId);
      this.store.setEnabled(botId, false);
    }
    this.invalidateRuntime(botId);
  }

  // ---- observation ---------------------------------------------------------

  getStatusSummaries(): BotStatusSummary[] {
    return this.store.list().map((m) => {
      const running = this.running.get(m.id);
      const queue = this.queues.get(m.id) ?? [];
      const last = this.lastRun.get(m.id);
      let state: BotLiveState = 'idle';
      if (!m.enabled || this.disabled.has(m.id)) state = 'disabled';
      else if (this.pausedForBudget.has(m.id)) state = 'paused';
      else if ((running?.size ?? 0) > 0) state = 'running';
      else if (queue.length > 0) state = 'queued';
      return {
        id: m.id,
        name: m.name,
        enabled: m.enabled,
        state,
        activity: this.activity.get(m.id),
        lastRunAt: last?.at,
        lastRunState: last?.state,
        needsYou: this.needsYou.has(m.id),
        fleetRole: m.fleetRole,
        parent: m.parent,
        crewWorking: m.fleetRole === 'lead'
          ? this.store.crewOf(m.id).filter(c => (this.running.get(c.id)?.size ?? 0) > 0).length
          : undefined,
      };
    });
  }

  getJournal(botId: string, limit = 20): BotRunRecord[] {
    return this.journalFor(botId).read(botId, limit);
  }

  getDlq(botId?: string): DurableBotJob[] {
    return this.queue.listDlq(botId);
  }

  /** Re-run a dead-lettered job: remove it from the DLQ and re-enqueue fresh. */
  replayDlq(botId: string, jobId: string): { accepted: boolean; jobId?: string; reasonCode?: string } {
    const entry = this.queue.removeFromDlq(jobId);
    if (!entry || entry.botId !== botId) return { accepted: false, reasonCode: 'not_found' };
    return this.enqueue(botId, {
      trigger: entry.trigger,
      prompt: entry.prompt,
      fromBot: entry.fromBot,
      source: entry.source,
      attempts: 0,
    });
  }

  getStorage(): Array<{ id: string; bytes: number; journalBytes: number }> {
    return this.store.usage();
  }

  getQueuedCount(botId: string): number {
    return (this.queues.get(botId) ?? []).length;
  }

  /** Resolve a bot by id or case-insensitive name (for @mention routing). */
  resolveBotId(nameOrId: string): string | null {
    const needle = nameOrId.toLowerCase();
    for (const m of this.store.list()) {
      if (m.id === needle || m.name.toLowerCase() === needle) return m.id;
    }
    return null;
  }

  /**
   * Compact bots section for the MAIN agent's system prompt: without it the
   * conversational agent is blind to the bot fleet — it cannot answer "what
   * do my bots do" or hand a task to the right specialist. Kept to a few
   * lines per bot so the token cost stays trivial.
   */
  getSystemPromptSection(): string {
    const summaries = this.store.list();
    if (summaries.length === 0) {
      // Empty fleet: no prompt section at all — zero-bots users must see
      // zero prompt/token drift (review A1).
      return '';
    }
    const lines: string[] = [
      '\n\nMercury Bots — the user maintains these persistent specialist agents (each has its own persona, model, memory, and permissions; they run OUTSIDE this conversation):',
    ];
    for (const m of summaries) {
      const state = this.running.get(m.id)?.size ? 'running' : ((this.queues.get(m.id)?.length ?? 0) > 0 ? 'queued' : (m.enabled ? 'idle' : 'disabled'));
      const desc = m.description ? ` — ${m.description}` : '';
      const fleetTag = m.fleetRole === 'lead' ? ' [fleet lead 👑]' : m.fleetRole === 'crew' ? ` [crew of ${m.parent}]` : '';
      lines.push(`- **${m.name}** (\`${m.id}\`)${desc}${fleetTag} [${state}]`);
    }
    lines.push(`Bot control (never route bot work through this main conversation):
- \`/bot <id> <message>\` or \`@<id> <message>\` — dispatch a task to a bot; the result lands ONLY in the bot's own thread (\`/bots open <id>\`), never in this chat.
- \`/bots open <id>\` — open the bot's own chat; \`/bots\` — roster with live states.
- \`/bots create <id> "Name" "Description"\` — onboard; \`/bots persona <id> <text>\` — set its character.
- \`/bots journal <id>\` — recent runs; \`/bots dlq\` — failed jobs (replayable); \`/bots stop|start|enable|disable <id>\`; \`/bots run <id> [routine]\` — fire a routine now (or a bare wake).
- Bots share data through the fleet-shared folder (\`${this.store.sharedSandboxDir()}\`); each also has a private sandbox next to its persona. Their outputs land in their own threads.
- The dispatch_bot tool lets you hand a task to a bot mid-conversation and continue talking; the result is delivered when the bot finishes.`);
    return lines.join('\n');
  }
}

function resolveProvider(providers: ProviderRegistry, manifest: BotManifest) {
  const requested = manifest.model?.provider;
  const provider = requested ? providers.get(requested) : undefined;
  if (provider) return provider;
  if (requested) {
    logger.warn({ botId: manifest.id, requested }, 'Bot provider not registered — falling back to default');
  }
  return providers.getDefault();
}

function describeJob(job: BotJob): string {
  switch (job.trigger) {
    case 'chat': return job.prompt ? `Responding: ${job.prompt.slice(0, 60)}` : 'Responding';
    case 'mailbox': return job.fromBot ? `Handling message from ${job.fromBot}` : 'Handling mailbox';
    case 'cron': return `Scheduled routine: ${job.prompt.slice(0, 60)}`;
    default: return `Handling ${job.trigger} request`;
  }
}

// Re-exported for the /bots storage view.
export { BOT_JOURNAL_FILENAME };