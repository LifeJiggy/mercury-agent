import { describe, expect, it } from 'vitest';
import { resolveGitHubApiUrl } from './github.js';

describe('resolveGitHubApiUrl', () => {
  it('prefixes relative API paths with the GitHub API base', () => {
    expect(resolveGitHubApiUrl('/repos/o/r/issues')).toBe('https://api.github.com/repos/o/r/issues');
  });

  it('allows absolute api.github.com URLs', () => {
    expect(resolveGitHubApiUrl('https://api.github.com/repos/o/r')).toBe('https://api.github.com/repos/o/r');
  });

  it('rejects plain http even for api.github.com (token must not transit plaintext)', () => {
    expect(() => resolveGitHubApiUrl('http://api.github.com/repos/o/r')).toThrow(/requires https/);
  });

  it('rejects absolute URLs to other hosts so the token cannot leak', () => {
    expect(() => resolveGitHubApiUrl('https://evil.example/steal')).toThrow(/restricted to api\.github\.com/);
    expect(() => resolveGitHubApiUrl('https://127.0.0.1:9/x')).toThrow(/restricted to api\.github\.com/);
    // userinfo tricks must not bypass the host check
    expect(() => resolveGitHubApiUrl('https://api.github.com@evil.example/')).toThrow(/restricted to api\.github\.com/);
  });

  it('rejects inputs that are neither an allowed URL nor an API path', () => {
    expect(() => resolveGitHubApiUrl('repos/o/r')).toThrow(/must start with/);
  });
});
