import { describe, it, expect } from 'vitest';
import { parsePersonaAccess } from './persona-access.js';

describe('parsePersonaAccess (## Access section → path scopes)', () => {
  it('parses one bullet per grant with read/write/execute modes', () => {
    const persona = `# Cookie bot

Eats cookies.

## Access

- ~/cookies — read
- ~/projects/site: read, write
- /usr/local/bin/tool — execute
- self — read, write

## Output

Concise.
`;
    expect(parsePersonaAccess(persona)).toEqual([
      { scope: '~/cookies', read: true, write: false, execute: false },
      { scope: '~/projects/site', read: true, write: true, execute: false },
      { scope: '/usr/local/bin/tool', read: false, write: false, execute: true },
      { scope: 'self', read: true, write: true, execute: false },
    ]);
  });

  it('supports quoted paths and r/w/x shorthand, and defaults a bare path to read', () => {
    const persona = `## Access

- "~/Library/Application Support/Cookies" — read
- \`~/notes\` — w
- ~/logs
`;
    expect(parsePersonaAccess(persona)).toEqual([
      { scope: '~/Library/Application Support/Cookies', read: true, write: false, execute: false },
      { scope: '~/notes', read: false, write: true, execute: false },
      { scope: '~/logs', read: true, write: false, execute: false },
    ]);
  });

  it('ignores prose, inline examples that are not bullets, and bullets without a path', () => {
    const persona = `## Access

You can always read and write inside your own profile directory. Examples:
\`- ~/some/dir — read\` · \`- ~/other/dir — read, write\` (these are template
examples, not grants). A granted directory covers everything inside it.
`;
    expect(parsePersonaAccess(persona)).toEqual([]);
  });

  it('an absent or empty section grants nothing (current permissions.yaml behavior)', () => {
    expect(parsePersonaAccess('')).toEqual([]);
    expect(parsePersonaAccess('# Bot\n\nNo access section here.\n')).toEqual([]);
    expect(parsePersonaAccess('## Access\n\n(nothing granted yet)\n')).toEqual([]);
  });

  it('stops at the next heading', () => {
    const persona = `## Access

- ~/granted — read

## Output

- ~/not-a-grant — read, write
`;
    expect(parsePersonaAccess(persona)).toEqual([{ scope: '~/granted', read: true, write: false, execute: false }]);
  });
});