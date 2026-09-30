import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './types.js';
import {
  buildMercuryBrandLines,
  buildMercuryMessageLines,
  parseChunkIndex,
  settledChunkEnds,
  splitFinalMessage,
  splitStreamingMessage,
  wrapMercuryText,
} from './mercury-transcript.js';

function message(partial: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    role: 'agent',
    content: 'Hello',
    timestamp: 1,
    ...partial,
  };
}

describe('Mercury Code transcript formatting', () => {
  it('wraps long text without dropping any words', () => {
    const source = 'Every part of this response remains visible even on a narrow terminal';
    const wrapped = wrapMercuryText(source, 20);

    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.join(' ').replace(/\s+/g, ' ')).toBe(source);
    expect(wrapped.every((line) => line.length <= 20)).toBe(true);
  });

  it('categorizes user and agent messages with explicit headers', () => {
    const user = buildMercuryMessageLines(message({ role: 'user', content: 'Please update the parser.' }), 60);
    const agent = buildMercuryMessageLines(message({ id: 'msg-2', content: 'I updated the parser.' }), 60);

    expect(user[0]).toMatchObject({ kind: 'header', text: 'YOU', role: 'user' });
    expect(agent[0]).toMatchObject({ kind: 'header', text: 'MERCURY', role: 'agent' });
  });

  it('keeps fenced code structured for syntax highlighting', () => {
    const lines = buildMercuryMessageLines(message({ content: 'Use this:\n```ts\nconst answer = 42;\n```' }), 60);

    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'code-label', text: 'TS', lang: 'ts' }),
      expect.objectContaining({ kind: 'code', text: 'const answer = 42;', lang: 'ts' }),
    ]));
  });

  it('hides heartbeats and renders one summary row per changed file', () => {
    expect(buildMercuryMessageLines(message({ id: 'heartbeat-1' }), 60)).toEqual([]);

    const lines = buildMercuryMessageLines(message({
      role: 'system',
      content: 'Task complete · 3 steps · 12s',
      fileChanges: [
        { path: 'src/app.ts', added: 8, removed: 2 },
        { path: 'public/logo.png', added: null, removed: null },
      ],
    }), 60);

    expect(lines.filter((line) => line.kind === 'file').map((line) => line.text)).toEqual([
      'src/app.ts  +8 -2',
      'public/logo.png  binary',
    ]);
  });
});

const FULL = [
  '# Refactor Plan',
  '',
  '## Overview',
  'We will split the auth module into three layers.',
  '',
  '- **Step one:** extract token verification',
  '- **Step two:** move session storage to redis',
  '',
  '## Details',
  '',
  '```ts',
  "import { verifyToken } from './auth';",
  'export function guard(req) {',
  '  return verifyToken(req.headers.authorization);',
  '}',
  '```',
  '',
  '## Rollout',
  'Ship behind a flag.',
].join('\n');

const chunkMessage = (content: string, streaming = false): ChatMessage => ({
  id: 'm1',
  role: 'agent',
  content,
  timestamp: 1,
  streaming,
});

/**
 * Progressive-flush splitter guards. <Static> prints each item exactly once,
 * so the chunk keys produced while a message streams must be a strict prefix
 * of the keys produced by the finalized content — otherwise finalization
 * re-prints blocks the user already saw (or drops them).
 */
describe('settled-chunk splitter (progressive streaming flush)', () => {
  it('reassembles into the original content exactly', () => {
    const chunks = splitFinalMessage(chunkMessage(FULL));
    expect(chunks.map((c) => c.content).join('')).toBe(FULL);
  });

  it('settled boundaries of every partial stream are a subset of the final boundaries', () => {
    const fullEnds = settledChunkEnds(FULL);
    for (let cut = 1; cut < FULL.length; cut++) {
      for (const end of settledChunkEnds(FULL.slice(0, cut))) {
        expect(fullEnds).toContain(end);
      }
    }
  });

  it('never settles a boundary inside an open code fence', () => {
    const unclosed = '```ts\nconst x = 1;\nstill inside the fence';
    expect(settledChunkEnds(unclosed)).toEqual([]);
    // A closed fence settles at the closer even without a trailing blank line.
    expect(settledChunkEnds('```ts\nconst x = 1;\n```\nnext')).toEqual([
      '```ts\nconst x = 1;\n```\n'.length,
    ]);
  });

  it('settles blank-line-terminated blocks only when content resumes after the blank', () => {
    // Trailing blank line(s) at the stream's current end are NOT a boundary —
    // more content could still continue the block.
    expect(settledChunkEnds('para one\n\n')).toEqual([]);
    expect(settledChunkEnds('para one\n\npara two')).toEqual(['para one\n\n'.length]);
  });

  it('streaming chunks exclude the unsettled remainder; finalize adds exactly one tail chunk', () => {
    let streamedIds: string[] = [];
    for (const cut of [20, 60, 120, FULL.length]) {
      const content = FULL.slice(0, cut);
      const { chunks, remainderStart } = splitStreamingMessage(chunkMessage(content, true));
      streamedIds = chunks.map((c) => c.id); // the last cut's chunk list is the streamed state
      // Settled chunks + remainder reassemble the streamed content.
      expect(chunks.map((c) => c.content).join('') + content.slice(remainderStart)).toBe(content);
    }
    const finalIds = splitFinalMessage(chunkMessage(FULL)).map((c) => c.id);
    // Every streamed chunk key must survive into the final list, in order.
    expect(finalIds.join(',').startsWith(streamedIds.join(','))).toBe(true);
    // Finalization adds exactly one NEW item (the tail chunk).
    expect(finalIds.length).toBe(streamedIds.length + 1);
  });

  it('carries fileChanges only on the last chunk', () => {
    const fileChanges = [{ path: 'src/a.ts', added: 3, removed: 1 }];
    const chunks = splitFinalMessage({ ...chunkMessage(FULL), fileChanges });
    expect(chunks.slice(0, -1).every((c) => c.fileChanges === undefined)).toBe(true);
    expect(chunks[chunks.length - 1].fileChanges).toEqual(fileChanges);
  });

  it('renders the role header only on chunk 0', () => {
    const chunks = splitFinalMessage(chunkMessage(FULL));
    expect(chunks.length).toBeGreaterThan(1);
    expect(buildMercuryMessageLines(chunks[0], 76).some((l) => l.kind === 'header')).toBe(true);
    for (const chunk of chunks.slice(1)) {
      expect(buildMercuryMessageLines(chunk, 76, { showHeader: false }).some((l) => l.kind === 'header')).toBe(false);
    }
    // Whole messages (no #c id) keep the header.
    expect(parseChunkIndex('m1')).toBeNull();
    expect(buildMercuryMessageLines(chunkMessage('hello'), 76).some((l) => l.kind === 'header')).toBe(true);
  });

  it('degenerate inputs: short and empty messages produce exactly one chunk', () => {
    expect(splitFinalMessage(chunkMessage('short answer')).map((c) => c.id)).toEqual(['m1#c0']);
    expect(splitFinalMessage(chunkMessage('')).map((c) => c.id)).toEqual(['m1#c0']);
  });
});

describe('dev-build badge on the TUI wordmark', () => {
  const devVersion = '1.2.7-dev.20260929.790d20a';

  it('badges the version row two-tone on dev builds', () => {
    const rows = buildMercuryBrandLines(devVersion, 120);
    const versionRow = rows.find((r) => r.key === 'brand:version');
    expect(versionRow).toBeDefined();
    expect(versionRow!.text).toContain(`v${devVersion}`);
    // Two-tone: the dev marker rides the accent segment, so it renders in the
    // wordmark's secondary color — not buried in the version string.
    expect(versionRow!.accent).toContain('dev build 20260929.790d20a');
  });

  it('leaves the version row clean on stable builds', () => {
    const rows = buildMercuryBrandLines('1.2.7', 120);
    const versionRow = rows.find((r) => r.key === 'brand:version');
    expect(versionRow).toBeDefined();
    expect(versionRow!.accent).toBe('');
    expect(versionRow!.text).toContain('v1.2.7');
  });
});
