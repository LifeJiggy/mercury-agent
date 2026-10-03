import { describe, it, expect } from 'vitest';
import { CLIChannel } from './cli.js';

/**
 * Per-bot live activity routing: while a bot runs, its OPEN thread shows a
 * live region ("what is this bot doing right now"); turn-end clears it. The
 * region must not flicker on tool-finish events (the running label stays).
 */
describe('CLIChannel per-bot live activity', () => {
  it('follows the bot activity bus and clears on turn-end', () => {
    const ch = new CLIChannel();

    ch.setBotLiveActivity('worker', { kind: 'turn-start', label: 'scrape the prices' });
    expect(ch.getTuiState().botLiveActivity['worker']).toMatchObject({ phase: 'Working', detail: 'scrape the prices' });

    ch.setBotLiveActivity('worker', { kind: 'step', label: 'step 1' });
    expect(ch.getTuiState().botLiveActivity['worker']).toMatchObject({ phase: 'step 1', stepsDone: 1 });

    ch.setBotLiveActivity('worker', { kind: 'tool', label: 'read_file ~/cookies', status: 'running' });
    expect(ch.getTuiState().botLiveActivity['worker']).toMatchObject({ phase: 'read_file ~/cookies' });

    // A tool finish keeps the last running label (no flicker).
    ch.setBotLiveActivity('worker', { kind: 'tool', label: 'read_file ~/cookies', status: 'done' });
    expect(ch.getTuiState().botLiveActivity['worker']).toMatchObject({ phase: 'read_file ~/cookies' });

    // An error shows inline.
    ch.setBotLiveActivity('worker', { kind: 'tool', label: 'run_command curl', status: 'error', detail: 'permission denied' });
    expect(ch.getTuiState().botLiveActivity['worker']).toMatchObject({ detail: '✗ run_command curl — permission denied' });

    ch.setBotLiveActivity('worker', { kind: 'turn-end', label: 'completed' });
    expect(ch.getTuiState().botLiveActivity['worker']).toBeUndefined();

    // Other bots' regions are untouched.
    ch.setBotLiveActivity('other', { kind: 'turn-start', label: 'other work' });
    ch.setBotLiveActivity('worker', { kind: 'turn-end', label: 'done' });
    expect(ch.getTuiState().botLiveActivity['other']).toBeDefined();
    expect(ch.getTuiState().botLiveActivity['worker']).toBeUndefined();
  });
});
describe('CLIChannel bot thinking stream tails', () => {
  const ch = new CLIChannel();

  ch.setBotLiveActivity('worker', { kind: 'turn-start', label: 'scrape the prices' });
  ch.setBotLiveActivity('worker', { kind: 'thinking', label: 'thinking', reasoningTail: 'I should scrape prices…', textTail: '' });
  it('stores the bot tail in botStreamTails', () => {
    expect(ch.getTuiState().botStreamTails?.['worker']).toEqual({ reasoning: 'I should scrape prices…', text: '' });
  });

  it('skips identical tail updates (no ink churn)', () => {
    ch.setBotLiveActivity('worker', { kind: 'thinking', label: 'thinking', reasoningTail: 'I should scrape prices…', textTail: '' });
    expect(ch.getTuiState().botStreamTails?.['worker']).toEqual({ reasoning: 'I should scrape prices…', text: '' });
  });

  it('updates the tail as the stream progresses', () => {
    ch.setBotLiveActivity('worker', { kind: 'thinking', label: 'thinking', reasoningTail: '…', textTail: 'partial reply' });
    expect(ch.getTuiState().botStreamTails?.['worker']).toEqual({ reasoning: '…', text: 'partial reply' });
  });

  it('a fresh turn discards the leftover tail', () => {
    ch.setBotLiveActivity('worker', { kind: 'turn-start', label: 'new task' });
    expect(ch.getTuiState().botStreamTails?.['worker']).toBeUndefined();
    expect(ch.getTuiState().botLiveActivity['worker']).toMatchObject({ phase: 'Working', detail: 'new task' });
  });

  it('turn-end clears both the live region and the tail', () => {
    ch.setBotLiveActivity('worker', { kind: 'thinking', label: 'thinking', reasoningTail: 'still thinking', textTail: '' });
    ch.setBotLiveActivity('worker', { kind: 'turn-end', label: 'completed' });
    expect(ch.getTuiState().botLiveActivity['worker']).toBeUndefined();
    expect(ch.getTuiState().botStreamTails?.['worker']).toBeUndefined();
  });
});
