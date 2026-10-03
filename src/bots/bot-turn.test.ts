import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock only streamText; stepCountIs must stay real so the turn loop's
// per-round step budget still applies. The mock must drive onStepFinish
// itself (that is the AI-SDK callback that decrements the budget) and
// return the streamText result shape: fullStream + final text/finishReason
// promises. runBotTurn consumes the deltas as live 'thinking' activity.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: vi.fn(),
  };
});

import { streamText } from 'ai';
import { runBotTurn, classifyFailure, type BotActivityEvent, type BotTurnInput } from './bot-turn.js';
import { MAX_AUTOMATIC_CONTINUATIONS } from '../core/execution-limits.js';

const mockedStreamText = vi.mocked(streamText);

/** streamText-shaped result: async fullStream + final promise fields. */
function streamedResult(opts: { fullStream?: any[]; text: string; finishReason: string; stream?: (opts: any) => any } = { text: '', finishReason: 'stop' }) {
  return {
    fullStream: (async function* () {
      for (const part of opts.fullStream ?? []) {
        if (part.type === '__sleep__') {
          await new Promise((resolve) => setTimeout(resolve, part.ms ?? 350));
          continue;
        }
        yield part;
      }
    })(),
    text: Promise.resolve(opts.text),
    finishReason: Promise.resolve(opts.finishReason),
    usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
  } as any;
}

function turnInput(overrides: Record<string, unknown> = {}): Parameters<typeof runBotTurn>[0] {
  return {
    manifest: {
      id: 'tester',
      name: 'Tester',
      enabled: true,
      autonomy: { maxSteps: 2 },
    } as any,
    trigger: 'chat',
    prompt: 'do the work',
    persona: 'test persona',
    mail: [],
    pollMail: () => [],
    sandbox: { workspace: '/tmp/ws', shared: '/tmp/shared' },
    capabilities: {} as any,
    tools: {},
    userMemory: null,
    provider: {
      name: 'stub',
      getModel: () => 'stub-model',
      getModelInstance: () => ({}),
    } as any,
    tokenBudget: { recordUsage: () => {}, getRemaining: () => 100000 } as any,
    abortSignal: new AbortController().signal,
    ...overrides,
  } as any;
}

beforeEach(() => {
  mockedStreamText.mockReset();
});

describe('runBotTurn step-budget continuation', () => {
  it('continues in-process with a fresh budget instead of pausing, preserving the conversation', async () => {
    // Round 1: burns the 2-step budget with tool calls still pending.
    // Round 2: finishes with text.
    mockedStreamText
      .mockImplementationOnce((opts: any) => {
        opts.onStepFinish?.({ usage: { inputTokens: 5, outputTokens: 2 }, toolCalls: [{ toolName: 'fs_write' }] });
        opts.onStepFinish?.({ usage: { inputTokens: 5, outputTokens: 2 }, toolCalls: [{ toolName: 'fs_write' }] });
        return streamedResult({ text: '', finishReason: 'tool-calls', usage: { inputTokens: 10, outputTokens: 4 } } as any);
      })
      .mockImplementationOnce((opts: any) => {
        opts.onStepFinish?.({ usage: { inputTokens: 5, outputTokens: 2 }, toolCalls: [] });
        return streamedResult({ text: 'all done', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 2 } } as any);
      });

    const output = await runBotTurn(turnInput());

    expect(output.status).toBe('completed');
    expect(output.output).toBe('all done');
    expect(mockedStreamText).toHaveBeenCalledTimes(2);
    // Tool usage from the pre-refill round is still attributed.
    expect(output.toolsUsed).toEqual(['fs_write']);
    expect(output.tokensIn).toBe(15);

    // The resume nudge carries the SAME conversation forward (messages grow,
    // not rebuild) and tells the model not to re-wrap the task.
    const secondCall = mockedStreamText.mock.calls[1][0] as any;
    const nudges = secondCall.messages.filter((m: any) => String(m.content).includes('[SYSTEM: STEP BUDGET]'));
    expect(nudges).toHaveLength(1);
  });

  it('stays bounded: past the continuation bound it returns paused with step_budget', async () => {
    mockedStreamText.mockImplementation((opts: any) => {
      opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ toolName: 'fs_write' }] });
      opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ toolName: 'fs_write' }] });
      return streamedResult({ text: '', finishReason: 'tool-calls', usage: { inputTokens: 2, outputTokens: 2 } } as any);
    });

    const output = await runBotTurn(turnInput());

    expect(output.status).toBe('paused');
    expect(output.reasonCode).toBe('step_budget');
    // Initial budget + one refill per continuation round.
    expect(mockedStreamText).toHaveBeenCalledTimes(MAX_AUTOMATIC_CONTINUATIONS + 1);
  });

  it('network blips classify as transient (retryable), not unknown_error', () => {
    // The live failure that shipped a lead bot to the DLQ with a needs-you
    // flag: "Cannot connect to API: read ECONNRESET" — a plain connection
    // drop that fell through every transient pattern.
    expect(classifyFailure(new Error('Cannot connect to API: read ECONNRESET'))).toBe('provider_timeout');
    expect(classifyFailure(new Error('getaddrinfo ENOTFOUND api.example.com'))).toBe('provider_timeout');
    expect(classifyFailure(new Error('fetch failed: ECONNREFUSED 1.2.3.4:443'))).toBe('provider_timeout');
    // "The operation timed out." (with a SPACE) is how several providers
    // phrase a deadline miss — it used to fall through to unknown_error and
    // ship long leader-bot turns straight to the DLQ instead of retrying.
    expect(classifyFailure(new Error('The operation timed out.'))).toBe('provider_timeout');
    expect(classifyFailure(new Error('Request timed out after 60000ms'))).toBe('provider_timeout');
    // Still-permanent things stay permanent.
    expect(classifyFailure(new Error('401 unauthorized'))).toBe('provider_auth');
    expect(classifyFailure(new Error('permission denied by policy'))).toBe('permission_denied');
  });

  it('an aborted turn during continuation still reports halted, not paused', async () => {
    const controller = new AbortController();
    mockedStreamText
      .mockImplementationOnce((opts: any) => {
        opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [] });
        opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [] });
        return streamedResult({ text: '', finishReason: 'tool-calls' } as any);
      })
      .mockImplementationOnce(() => {
        controller.abort();
        throw new Error('Request was aborted');
      });

    const output = await runBotTurn(turnInput({ abortSignal: controller.signal }));

    expect(output.status).toBe('halted');
  });
});
describe('runBotTurn live thinking events', () => {
  const activityEvents: any[] = [];
  function inputWithActivity(overrides: Record<string, unknown> = {}): Parameters<typeof runBotTurn>[0] {
    activityEvents.length = 0;
    return turnInput({ onActivity: (ev: BotActivityEvent) => activityEvents.push(ev), ...overrides });
  }

  it('emits cumulative reasoning/text tails at throttle boundaries and a final flush', async () => {
    mockedStreamText.mockImplementationOnce((opts: any) =>
      streamedResult({
        text: 'final reply text',
        finishReason: 'stop',
        fullStream: [
          { type: 'start-step', request: {}, warnings: [] },
          { type: 'reasoning-delta', id: 'r', text: 'I should check the prices' },
          { type: 'reasoning-delta', id: 'r', text: ' then plan the write' },
          { type: '__sleep__', ms: 350 }, // crosses the 300ms throttle boundary
          { type: 'reasoning-delta', id: 'r', text: ' and now act' },
          { type: 'text-delta', id: 't', text: 'partial reply' },
          { type: 'text-delta', id: 't', text: ' more' },
        ],
      }),
    );
    const output = await runBotTurn(inputWithActivity());

    expect(output.status).toBe('completed');
    const thinking = activityEvents.filter((e) => e.kind === 'thinking');
    // At least the crossed-throttle boundary emission + the final flush.
    expect(thinking.length).toBeGreaterThanOrEqual(2);
    const last = thinking.at(-1);
    expect(last.reasoningTail).toContain('I should check the prices');
    expect(last.reasoningTail).toContain('and now act');
    expect(last.textTail).toBe('partial reply more');
  });

  it('inserts a paragraph break at step boundaries so step narrations do not run together', async () => {
    mockedStreamText.mockImplementationOnce((opts: any) =>
      streamedResult({
        text: 'done',
        finishReason: 'stop',
        fullStream: [
          { type: 'start-step', request: {}, warnings: [] },
          { type: 'text-delta', id: 't', text: 'first step narration' },
          { type: 'start-step', request: {}, warnings: [] },
          { type: 'text-delta', id: 't', text: 'second step narration' },
        ],
      }),
    );
    const output = await runBotTurn(inputWithActivity());
    expect(output.status).toBe('completed');
    const thinking = activityEvents.filter((e) => e.kind === 'thinking');
    const lastTextTail = thinking.at(-1).textTail;
    expect(lastTextTail).toContain('first step narration');
    expect(lastTextTail).toContain('second step narration');
    expect(lastTextTail).toContain('\n\n');
  });

  it('providers without reasoning produce text tails only', async () => {
    mockedStreamText.mockImplementationOnce((opts: any) =>
      streamedResult({
        text: 'reply',
        finishReason: 'stop',
        fullStream: [
          { type: 'text-delta', id: 't', text: 'reply streaming' },
        ],
      }),
    );
    const output = await runBotTurn(inputWithActivity());
    expect(output.status).toBe('completed');
    const thinking = activityEvents.filter((e) => e.kind === 'thinking');
    expect(thinking.length).toBeGreaterThanOrEqual(1);
    expect(thinking.at(-1).textTail).toBe('reply streaming');
    expect(thinking.at(-1).reasoningTail).toBe('');
  });

  it('tails restart with each turn round (a new generation thinks anew)', async () => {
    let round = 0;
    mockedStreamText.mockImplementation((opts: any) => {
      round++;
      if (round === 1) {
        opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ toolName: 'fs_write' }] });
        return streamedResult({ text: '', finishReason: 'tool-calls', fullStream: [{ type: 'text-delta', id: 't', text: 'round one thoughts' }] });
      }
      opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [] });
      return streamedResult({ text: 'ok', finishReason: 'stop', fullStream: [{ type: 'text-delta', id: 't', text: 'round two thoughts' }] });
    });
    const output = await runBotTurn(inputWithActivity({ manifest: { id: 't', name: 'T', enabled: true, autonomy: { maxSteps: 1 } } as any }));
    expect(output.output).toBe('ok');
    const thinking = activityEvents.filter((e) => e.kind === 'thinking');
    const firstRound = thinking.filter((e) => e.textTail.includes('round one'));
    const secondRound = thinking.filter((e) => e.textTail.includes('round two') && !e.textTail.includes('round one'));
    expect(firstRound.length).toBeGreaterThan(0);
    expect(secondRound.length).toBeGreaterThan(0);
  });
});
