import { describe, expect, it } from 'vitest';
import { devBuildLabel, devBuildTag, isDevBuild } from './dev-build.js';

describe('dev-build marker', () => {
  it('marks publish-dev.sh dev stamps as dev builds', () => {
    expect(isDevBuild('1.2.7-dev.20260929.790d20a')).toBe(true);
    expect(isDevBuild('1.2.8-dev.20261001.abc1234')).toBe(true);
  });

  it('never marks stable, npm, or unknown versions as dev builds', () => {
    expect(isDevBuild('1.2.7')).toBe(false);
    expect(isDevBuild('0.0.5')).toBe(false);
    expect(isDevBuild('unknown')).toBe(false);
    expect(isDevBuild('')).toBe(false);
  });

  it('extracts the dev tag from the canonical stamp shape', () => {
    expect(devBuildTag('1.2.7-dev.20260929.790d20a')).toBe('20260929.790d20a');
  });

  it('falls back gracefully for hand-written dev stamps', () => {
    // No canonical <date>.<sha> suffix — keep whatever followed -dev.
    expect(devBuildTag('1.2.7-dev.9')).toBe('9');
    expect(devBuildLabel('1.2.7-dev.9')).toBe('dev build 9');
  });

  it('labels are empty for stable versions', () => {
    expect(devBuildLabel('1.2.7')).toBe('');
    expect(devBuildTag('1.2.7')).toBe('1.2.7');
    expect(devBuildTag('unknown')).toBe('unknown');
  });
});