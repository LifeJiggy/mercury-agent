import { describe, expect, it } from 'vitest';
import { filterToolsByAllowlist } from './tool-filter.js';

const tools = {
  read_file: 1,
  write_file: 2,
  list_agents: 3,
  stop_agent: 4,
};

describe('filterToolsByAllowlist', () => {
  it('returns every tool when no allowlist is given', () => {
    expect(filterToolsByAllowlist(tools)).toEqual(tools);
    expect(filterToolsByAllowlist(tools, [])).toEqual(tools);
  });

  it('keeps only the allowed tools', () => {
    expect(filterToolsByAllowlist(tools, ['read_file'])).toEqual({ read_file: 1 });
    expect(filterToolsByAllowlist(tools, ['read_file', 'write_file'])).toEqual({ read_file: 1, write_file: 2 });
  });

  it('drops orchestration tools that are not allowlisted', () => {
    const filtered = filterToolsByAllowlist(tools, ['read_file']);
    expect(filtered).not.toHaveProperty('list_agents');
    expect(filtered).not.toHaveProperty('stop_agent');
  });

  it('ignores allowlist entries that match no tool', () => {
    expect(filterToolsByAllowlist(tools, ['read_file', 'does_not_exist'])).toEqual({ read_file: 1 });
  });
});
