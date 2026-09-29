import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillLoader } from './loader.js';

describe('SkillLoader skill-name confinement', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-skills-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a normal skill inside the skills root', () => {
    const loader = new SkillLoader(root);
    const dir = loader.saveSkill('good-skill', '# Good\n');
    expect(dir.startsWith(root)).toBe(true);
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);
  });

  it('rejects names that escape the skills root', () => {
    const loader = new SkillLoader(root);
    for (const name of ['..', '../evil', '../../evil', '/tmp/evil', 'nested/../../evil']) {
      expect(() => loader.saveSkill(name, '# Evil\n')).toThrow(/outside the skills root/);
    }
  });

  it('rejects a traversal name coming from remote SKILL.md frontmatter', () => {
    const loader = new SkillLoader(root);
    const content = ['---', 'name: ../../evil-skill', 'description: pwned', '---', 'body'].join('\n');
    expect(() => loader.installFromContent(content)).toThrow(/outside the skills root/);
  });
});

describe('SkillLoader extra skill roots (per-bot libraries)', () => {
  let root: string;
  let botSkills: string;

  beforeEach(() => {
    // Both roots are NOT-yet-existing children so the seedDefaults test can
    // prove the loader never touches the primary root.
    root = join(mkdtempSync(join(tmpdir(), 'mercury-skills-extra-')), 'skills');
    botSkills = join(mkdtempSync(join(tmpdir(), 'mercury-skills-bot-')), 'skills');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSkill(dir: string, slug: string, name: string, description: string) {
    const skillDir = join(dir, slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n\nDo the ${name} thing.\n`);
    return skillDir;
  }

  it('discovers skills from extraDirs alongside the primary root', () => {
    writeSkill(join(root, 'shared'), 'shared-skill', 'shared-skill', 'x');
    writeSkill(botSkills, 'own-skill', 'own-skill', 'x');
    const loader = new SkillLoader(root, { extraDirs: [botSkills], seedDefaults: false });
    const names = loader.discover().map(s => s.name).sort();
    expect(names).toContain('shared-skill');
    expect(names).toContain('own-skill');
  });

  it('own-dir skills win on name collision with the primary root', () => {
    writeSkill(join(root, 'digest'), 'digest', 'digest', 'x');
    writeSkill(botSkills, 'digest', 'digest', 'x');
    const loader = new SkillLoader(root, { extraDirs: [botSkills], seedDefaults: false });
    loader.discover();
    const skill = loader.load('digest');
    // The bot's own version loads (extraDirs walk last, and load prefers the deepest/last match)
    expect(skill).not.toBeNull();
    expect(skill?.instructions).toContain('Do the digest thing');
  });

  it('seedDefaults:false never writes into the primary root (bots are read-only guests there)', () => {
    new SkillLoader(root, { extraDirs: [botSkills], seedDefaults: false }).discover();
    expect(existsSync(root)).toBe(false); // no mkdir, no default-seed writes
  });
});
