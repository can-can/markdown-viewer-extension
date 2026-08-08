import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  parseWorktreeList,
  listWorktrees,
  repoKeyOf,
} from '../desktop/src/main/git-worktrees.ts';

describe('parseWorktreeList', () => {
  it('reads several records and strips refs/heads/', () => {
    const out = [
      'worktree /tmp/repo',
      'HEAD 79bedb8',
      'branch refs/heads/main',
      '',
      'worktree /tmp/feature-a',
      'HEAD 79bedb8',
      'branch refs/heads/feature-a',
      '',
    ].join('\n');

    assert.deepEqual(parseWorktreeList(out), [
      { path: '/tmp/repo', branch: 'main', detached: false, bare: false, prunable: false },
      { path: '/tmp/feature-a', branch: 'feature-a', detached: false, bare: false, prunable: false },
    ]);
  });

  it('gives branch null for a detached record', () => {
    const out = 'worktree /tmp/d\nHEAD 79bedb8\ndetached\n';
    const [record] = parseWorktreeList(out);
    assert.equal(record.branch, null);
    assert.equal(record.detached, true);
  });

  it('marks a bare record', () => {
    const [record] = parseWorktreeList('worktree /tmp/bare\nbare\n');
    assert.equal(record.bare, true);
  });

  it('marks a prunable record and keeps its branch', () => {
    const out = [
      'worktree /tmp/gone',
      'HEAD 79bedb8',
      'branch refs/heads/gone',
      'prunable gitdir file points to non-existent location',
    ].join('\n');
    const [record] = parseWorktreeList(out);
    assert.equal(record.prunable, true);
    assert.equal(record.branch, 'gone');
  });

  it('returns an empty list for empty output', () => {
    assert.deepEqual(parseWorktreeList(''), []);
    assert.deepEqual(parseWorktreeList('\n\n'), []);
  });

  it('ignores lines it does not know', () => {
    const out = 'worktree /tmp/a\nHEAD 79bedb8\nlocked reason here\nsomethingnew\nbranch refs/heads/a\n';
    assert.deepEqual(parseWorktreeList(out), [
      { path: '/tmp/a', branch: 'a', detached: false, bare: false, prunable: false },
    ]);
  });

  it('keeps a record that has no closing blank line', () => {
    assert.equal(parseWorktreeList('worktree /tmp/a\nbranch refs/heads/a').length, 1);
  });

  it('keeps a path that contains a space', () => {
    const [record] = parseWorktreeList('worktree /tmp/my repo\nbranch refs/heads/main\n');
    assert.equal(record.path, '/tmp/my repo');
  });
});

describe('listWorktrees and repoKeyOf against a real repository', () => {
  let base: string;
  let repo: string;
  let linked: string;

  before(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'docmd-git-')));
    repo = path.join(base, 'repo');
    linked = path.join(base, 'feature-a');

    const git = (cwd: string, ...args: string[]): void => {
      execFileSync('git', args, { cwd, stdio: 'ignore' });
    };
    await fs.mkdir(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(repo, 'README.md'), '# Main\n', 'utf8');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'feature-a');
  });

  after(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('reports both worktrees, main first', async () => {
    const list = await listWorktrees(repo);
    assert.deepEqual(list.map((w) => w.path), [repo, linked]);
    assert.deepEqual(list.map((w) => w.branch), ['main', 'feature-a']);
  });

  it('reports the same list from the linked worktree', async () => {
    assert.deepEqual(
      (await listWorktrees(linked)).map((w) => w.path),
      [repo, linked],
    );
  });

  it('gives the same repoKey from both worktrees', async () => {
    const fromMain = await repoKeyOf(repo);
    const fromLinked = await repoKeyOf(linked);
    assert.equal(fromMain, path.join(repo, '.git'));
    assert.equal(fromLinked, fromMain, 'both worktrees must group under one tab');
  });

  it('does not report a plain subfolder as a worktree', async () => {
    // A folder inside a repository answers repoKeyOf, because git walks up.
    // It is still not a worktree. The app must compare the folder path against
    // the worktree list, or two subfolders of one repository would collapse
    // into a single repository tab.
    const inside = path.join(repo, 'docs');
    await fs.mkdir(inside, { recursive: true });

    assert.equal(await repoKeyOf(inside), path.join(repo, '.git'), 'git walks up');
    assert.equal(
      (await listWorktrees(inside)).some((w) => w.path === inside),
      false,
      'a subfolder must never appear in the worktree list',
    );
  });

  it('returns nothing for a folder that is not a repository', async () => {
    const plain = path.join(base, 'plain');
    await fs.mkdir(plain, { recursive: true });
    assert.deepEqual(await listWorktrees(plain), []);
    assert.equal(await repoKeyOf(plain), null);
  });
});
