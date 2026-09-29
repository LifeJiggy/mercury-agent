import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock only generateText; stepCountIs must stay real so the turn loop's
// per-round step budget still applies. The mock must drive onStepFinish
// itself — that is the AI-SDK callback that decrements the budget.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

import { generateText } from 'ai';
import { runBotTurn, classifyFailure, type BotTurnInput } from './bot-turn.js';
import { MAX_AUTOMATIC_CONTINUATIONS } from '../core/execution-limits.js';

const mockedGenerateText = vi.mocked(generateText);

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
  mockedGenerateText.mockReset();
});

describe('runBotTurn step-budget continuation', () => {
  it('continues in-process with a fresh budget instead of pausing, preserving the conversation', async () => {
    // Round 1: burns the 2-step budget with tool calls still pending.
    // Round 2: finishes with text.
    mockedGenerateText
      .mockImplementationOnce(async (opts: any) => {
        opts.onStepFinish?.({ usage: { inputTokens: 5, outputTokens: 2 }, toolCalls: [{ toolName: 'fs_write' }] });
        opts.onStepFinish?.({ usage: { inputTokens: 5, outputTokens: 2 }, toolCalls: [{ toolName: 'fs_write' }] });
        return { text: '', finishReason: 'tool-calls', usage: { inputTokens: 10, outputTokens: 4 } } as any;
      })
      .mockImplementationOnce(async (opts: any) => {
        opts.onStepFinish?.({ usage: { inputTokens: 5, outputTokens: 2 }, toolCalls: [] });
        return { text: 'all done', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 2 } } as any;
      });

    const output = await runBotTurn(turnInput());

    expect(output.status).toBe('completed');
    expect(output.output).toBe('all done');
    expect(mockedGenerateText).toHaveBeenCalledTimes(2);
    // Tool usage from the pre-refill round is still attributed.
    expect(output.toolsUsed).toEqual(['fs_write']);
    expect(output.tokensIn).toBe(15);

    // The resume nudge carries the SAME conversation forward (messages grow,
    // not rebuild) and tells the model not to re-wrap the task.
    const secondCall = mockedGenerateText.mock.calls[1][0] as any;
    const nudges = secondCall.messages.filter((m: any) => String(m.content).includes('[SYSTEM: STEP BUDGET]'));
    expect(nudges).toHaveLength(1);
  });

  it('stays bounded: past the continuation bound it returns paused with step_budget', async () => {
    mockedGenerateText.mockImplementation(async (opts: any) => {
      opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ toolName: 'fs_write' }] });
      opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ toolName: 'fs_write' }] });
      return { text: '', finishReason: 'tool-calls', usage: { inputTokens: 2, outputTokens: 2 } } as any;
    });

    const output = await runBotTurn(turnInput());

    expect(output.status).toBe('paused');
    expect(output.reasonCode).toBe('step_budget');
    // Initial budget + one refill per continuation round.
    expect(mockedGenerateText).toHaveBeenCalledTimes(MAX_AUTOMATIC_CONTINUATIONS + 1);
  });

  it('network blips classify as transient (retryable), not unknown_error', () => {
    // The live failure that shipped a lead bot to the DLQ with a needs-you
    // flag: "Cannot connect to API: read ECONNRESET" — a plain connection
    // drop that fell through every transient pattern.
    expect(classifyFailure(new Error('Cannot connect to API: read ECONNRESET'))).toBe('provider_timeout');
    expect(classifyFailure(new Error('getaddrinfo ENOTFOUND api.example.com'))).toBe('provider_timeout');
    expect(classifyFailure(new Error('fetch failed: ECONNREFUSED 1.2.3.4:443'))).toBe('provider_timeout');
    // Still-permanent things stay permanent.
    expect(classifyFailure(new Error('401 unauthorized'))).toBe('provider_auth');
    expect(classifyFailure(new Error('permission denied by policy'))).toBe('permission_denied');
  });

  it('an aborted turn during continuation still reports halted, not paused', async () => {
    const controller = new AbortController();
    mockedGenerateText
      .mockImplementationOnce(async (opts: any) => {
        opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [] });
        opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [] });
        return { text: '', finishReason: 'tool-calls' } as any;
      })
      .mockImplementationOnce(async () => {
        controller.abort();
        throw new Error('Request was aborted');
      });

    const output = await runBotTurn(turnInput({ abortSignal: controller.signal }));

    expect(output.status).toBe('halted');
  });
});