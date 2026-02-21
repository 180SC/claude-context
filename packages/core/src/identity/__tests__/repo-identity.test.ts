/**
 * Unit tests for repository identity detection.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  resolveIdentity,
  resolveIdentityFromUrl,
  isSameRepository,
  RepoIdentity,
} from '../repo-identity';
import {
  normalizeGitUrl,
  detectGitRepo,
  findGitPath,
} from '../git-utils';

// Helper to create a temporary directory
function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Helper to clean up a directory
function cleanupDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Ignore errors during cleanup
  }
}

// Helper to run git commands (disables commit signing for test environments)
function git(cwd: string, ...args: string[]): string {
  // Disable commit signing for tests
  const env = {
    ...process.env,
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.com',
  };

  return execSync(`git -c commit.gpgsign=false -c user.name="Test User" -c user.email="test@example.com" ${args.join(' ')}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  }).trim();
}

describe('normalizeGitUrl', () => {
  describe('SSH URLs', () => {
    it('normalizes git@github.com:user/repo.git', () => {
      expect(normalizeGitUrl('git@github.com:user/repo.git')).toBe('github.com/user/repo');
    });

    it('normalizes git@github.com:user/repo (no .git suffix)', () => {
      expect(normalizeGitUrl('git@github.com:user/repo')).toBe('github.com/user/repo');
    });

    it('normalizes git@gitlab.com:org/project/repo.git', () => {
      expect(normalizeGitUrl('git@gitlab.com:org/project/repo.git')).toBe('gitlab.com/org/project/repo');
    });

    it('normalizes ssh://git@github.com/user/repo.git', () => {
      expect(normalizeGitUrl('ssh://git@github.com/user/repo.git')).toBe('github.com/user/repo');
    });
  });

  describe('HTTPS URLs', () => {
    it('normalizes https://github.com/user/repo.git', () => {
      expect(normalizeGitUrl('https://github.com/user/repo.git')).toBe('github.com/user/repo');
    });

    it('normalizes https://github.com/user/repo (no .git suffix)', () => {
      expect(normalizeGitUrl('https://github.com/user/repo')).toBe('github.com/user/repo');
    });

    it('normalizes http://github.com/user/repo.git', () => {
      expect(normalizeGitUrl('http://github.com/user/repo.git')).toBe('github.com/user/repo');
    });

    it('normalizes URLs with authentication', () => {
      expect(normalizeGitUrl('https://token@github.com/user/repo.git')).toBe('github.com/user/repo');
    });
  });

  describe('Git protocol URLs', () => {
    it('normalizes git://github.com/user/repo.git', () => {
      expect(normalizeGitUrl('git://github.com/user/repo.git')).toBe('github.com/user/repo');
    });
  });

  describe('Edge cases', () => {
    it('returns null for empty string', () => {
      expect(normalizeGitUrl('')).toBeNull();
    });

    it('returns null for null input', () => {
      expect(normalizeGitUrl(null as any)).toBeNull();
    });

    it('returns null for file:// URLs', () => {
      expect(normalizeGitUrl('file:///path/to/repo')).toBeNull();
    });

    it('returns null for invalid URLs', () => {
      expect(normalizeGitUrl('not-a-valid-url')).toBeNull();
    });
  });

  describe('URL normalization produces same result for SSH and HTTPS', () => {
    it('github.com SSH and HTTPS produce same result', () => {
      const ssh = normalizeGitUrl('git@github.com:user/repo.git');
      const https = normalizeGitUrl('https://github.com/user/repo.git');
      expect(ssh).toBe(https);
      expect(ssh).toBe('github.com/user/repo');
    });

    it('gitlab.com SSH and HTTPS produce same result', () => {
      const ssh = normalizeGitUrl('git@gitlab.com:org/repo.git');
      const https = normalizeGitUrl('https://gitlab.com/org/repo.git');
      expect(ssh).toBe(https);
    });
  });
});

describe('findGitPath', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('git-test-');
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('returns null for non-git directory', () => {
    const result = findGitPath(tempDir);
    expect(result).toBeNull();
  });

  it('finds .git directory in a git repo', () => {
    git(tempDir, 'init');
    const result = findGitPath(tempDir);
    expect(result).not.toBeNull();
    expect(result?.isFile).toBe(false);
    expect(result?.gitPath).toBe(path.join(tempDir, '.git'));
  });

  it('finds .git from a subdirectory', () => {
    git(tempDir, 'init');
    const subDir = path.join(tempDir, 'src', 'deep', 'nested');
    fs.mkdirSync(subDir, { recursive: true });

    const result = findGitPath(subDir);
    expect(result).not.toBeNull();
    expect(result?.gitPath).toBe(path.join(tempDir, '.git'));
  });
});

describe('detectGitRepo', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('git-detect-');
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('returns isGitRepo: false for non-git directory', () => {
    const result = detectGitRepo(tempDir);
    expect(result.isGitRepo).toBe(false);
    expect(result.isWorktree).toBe(false);
  });

  it('detects a regular git repository', () => {
    git(tempDir, 'init');
    const result = detectGitRepo(tempDir);
    expect(result.isGitRepo).toBe(true);
    expect(result.isWorktree).toBe(false);
    expect(result.repoRoot).toBe(tempDir);
  });
});

describe('resolveIdentity', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('identity-test-');
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  describe('non-git directories', () => {
    it('returns path-hash identity for non-git directory', () => {
      const identity = resolveIdentity(tempDir);
      expect(identity.isGitRepo).toBe(false);
      expect(identity.identitySource).toBe('path-hash');
      expect(identity.canonicalId).toBeTruthy();
      expect(identity.detectedPaths).toContain(tempDir);
    });

    it('generates different IDs for different non-git paths', () => {
      const dir1 = createTempDir('id-test-1-');
      const dir2 = createTempDir('id-test-2-');

      try {
        const id1 = resolveIdentity(dir1);
        const id2 = resolveIdentity(dir2);
        expect(id1.canonicalId).not.toBe(id2.canonicalId);
      } finally {
        cleanupDir(dir1);
        cleanupDir(dir2);
      }
    });
  });

  describe('git repositories with remotes', () => {
    it('uses remote URL for canonical ID', () => {
      git(tempDir, 'init');
      git(tempDir, 'commit', '--allow-empty', '-m', '"init"');
      git(tempDir, 'remote', 'add', 'origin', 'git@github.com:test/repo.git');

      const identity = resolveIdentity(tempDir);
      expect(identity.isGitRepo).toBe(true);
      expect(identity.identitySource).toBe('remote-url');
      expect(identity.remoteUrl).toBe('github.com/test/repo');
      expect(identity.displayName).toBe('repo');
    });

    it('generates same ID for SSH and HTTPS remotes', () => {
      const sshDir = createTempDir('ssh-remote-');
      const httpsDir = createTempDir('https-remote-');

      try {
        // Setup SSH remote repo
        git(sshDir, 'init');
        git(sshDir, 'commit', '--allow-empty', '-m', '"init"');
        git(sshDir, 'remote', 'add', 'origin', 'git@github.com:test/myrepo.git');

        // Setup HTTPS remote repo
        git(httpsDir, 'init');
        git(httpsDir, 'commit', '--allow-empty', '-m', '"init"');
        git(httpsDir, 'remote', 'add', 'origin', 'https://github.com/test/myrepo.git');

        const sshIdentity = resolveIdentity(sshDir);
        const httpsIdentity = resolveIdentity(httpsDir);

        expect(sshIdentity.canonicalId).toBe(httpsIdentity.canonicalId);
        expect(sshIdentity.remoteUrl).toBe(httpsIdentity.remoteUrl);
      } finally {
        cleanupDir(sshDir);
        cleanupDir(httpsDir);
      }
    });
  });

  describe('git repositories without remotes', () => {
    it('falls back to initial commit SHA', () => {
      git(tempDir, 'init');
      git(tempDir, 'commit', '--allow-empty', '-m', '"init"');

      const identity = resolveIdentity(tempDir);
      expect(identity.isGitRepo).toBe(true);
      expect(identity.identitySource).toBe('initial-commit');
      expect(identity.remoteUrl).toBeUndefined();
    });

    it('generates same ID for repos with same initial commit', () => {
      // This test creates two repos and sets them to have the same initial commit
      // by having one clone from the other (without adding a remote)
      git(tempDir, 'init');
      git(tempDir, 'commit', '--allow-empty', '-m', '"init"');

      const cloneDir = createTempDir('clone-');
      try {
        // Clone locally (will have origin set to tempDir)
        git(cloneDir, 'clone', tempDir, '.');
        // Remove the origin to test initial-commit fallback
        git(cloneDir, 'remote', 'remove', 'origin');

        const id1 = resolveIdentity(tempDir);
        const id2 = resolveIdentity(cloneDir);

        // Both should use initial-commit and have the same ID
        expect(id1.identitySource).toBe('initial-commit');
        expect(id2.identitySource).toBe('initial-commit');
        expect(id1.canonicalId).toBe(id2.canonicalId);
      } finally {
        cleanupDir(cloneDir);
      }
    });
  });

  describe('git repositories with no commits', () => {
    it('falls back to path hash', () => {
      git(tempDir, 'init');
      // No commits made

      const identity = resolveIdentity(tempDir);
      expect(identity.isGitRepo).toBe(true);
      expect(identity.identitySource).toBe('path-hash');
    });
  });

  describe('worktrees', () => {
    it('returns same ID for main repo and worktree', () => {
      // Create main repo with a commit
      git(tempDir, 'init');
      fs.writeFileSync(path.join(tempDir, 'file.txt'), 'content');
      git(tempDir, 'add', '.');
      git(tempDir, 'commit', '-m', '"initial commit"');
      git(tempDir, 'remote', 'add', 'origin', 'git@github.com:test/worktree-repo.git');

      // Create a worktree
      const worktreeDir = createTempDir('worktree-');
      cleanupDir(worktreeDir); // git worktree add needs an empty or non-existent directory

      try {
        git(tempDir, 'worktree', 'add', worktreeDir, '-b', 'feature');

        const mainIdentity = resolveIdentity(tempDir);
        const worktreeIdentity = resolveIdentity(worktreeDir);

        expect(mainIdentity.canonicalId).toBe(worktreeIdentity.canonicalId);
        expect(mainIdentity.remoteUrl).toBe(worktreeIdentity.remoteUrl);
        expect(worktreeIdentity.isWorktree).toBe(true);
        expect(mainIdentity.isWorktree).toBe(false);
      } finally {
        // Clean up worktree first
        try {
          git(tempDir, 'worktree', 'remove', worktreeDir, '--force');
        } catch {
          cleanupDir(worktreeDir);
        }
      }
    });

    it('detects worktree and sets mainWorktreePath', () => {
      // Create main repo
      git(tempDir, 'init');
      fs.writeFileSync(path.join(tempDir, 'file.txt'), 'content');
      git(tempDir, 'add', '.');
      git(tempDir, 'commit', '-m', '"initial"');

      const worktreeDir = createTempDir('wt-detect-');
      cleanupDir(worktreeDir);

      try {
        git(tempDir, 'worktree', 'add', worktreeDir, '-b', 'test-branch');

        const identity = resolveIdentity(worktreeDir);
        expect(identity.isWorktree).toBe(true);
        expect(identity.mainWorktreePath).toBe(tempDir);
      } finally {
        try {
          git(tempDir, 'worktree', 'remove', worktreeDir, '--force');
        } catch {
          cleanupDir(worktreeDir);
        }
      }
    });

    it('includes all worktrees in detectedPaths', () => {
      git(tempDir, 'init');
      fs.writeFileSync(path.join(tempDir, 'file.txt'), 'content');
      git(tempDir, 'add', '.');
      git(tempDir, 'commit', '-m', '"initial"');

      const wt1 = createTempDir('wt1-');
      const wt2 = createTempDir('wt2-');
      cleanupDir(wt1);
      cleanupDir(wt2);

      try {
        git(tempDir, 'worktree', 'add', wt1, '-b', 'branch1');
        git(tempDir, 'worktree', 'add', wt2, '-b', 'branch2');

        const identity = resolveIdentity(tempDir);
        expect(identity.detectedPaths).toContain(tempDir);
        expect(identity.detectedPaths).toContain(wt1);
        expect(identity.detectedPaths).toContain(wt2);
        expect(identity.detectedPaths.length).toBeGreaterThanOrEqual(3);
      } finally {
        try {
          git(tempDir, 'worktree', 'remove', wt1, '--force');
          git(tempDir, 'worktree', 'remove', wt2, '--force');
        } catch {
          cleanupDir(wt1);
          cleanupDir(wt2);
        }
      }
    });
  });
});

describe('resolveIdentityFromUrl', () => {
  it('returns canonical ID and normalized URL for valid SSH URL', () => {
    const result = resolveIdentityFromUrl('git@github.com:user/repo.git');
    expect(result).not.toBeNull();
    expect(result?.normalizedUrl).toBe('github.com/user/repo');
    expect(result?.canonicalId).toBeTruthy();
  });

  it('returns canonical ID and normalized URL for valid HTTPS URL', () => {
    const result = resolveIdentityFromUrl('https://github.com/user/repo.git');
    expect(result).not.toBeNull();
    expect(result?.normalizedUrl).toBe('github.com/user/repo');
  });

  it('returns null for invalid URL', () => {
    const result = resolveIdentityFromUrl('invalid-url');
    expect(result).toBeNull();
  });

  it('generates same canonical ID for SSH and HTTPS URLs', () => {
    const ssh = resolveIdentityFromUrl('git@github.com:user/repo.git');
    const https = resolveIdentityFromUrl('https://github.com/user/repo.git');
    expect(ssh?.canonicalId).toBe(https?.canonicalId);
  });
});

describe('isSameRepository', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('same-repo-');
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('returns true for same directory', () => {
    git(tempDir, 'init');
    git(tempDir, 'commit', '--allow-empty', '-m', '"init"');

    expect(isSameRepository(tempDir, tempDir)).toBe(true);
  });

  it('returns true for worktree and main repo', () => {
    git(tempDir, 'init');
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'content');
    git(tempDir, 'add', '.');
    git(tempDir, 'commit', '-m', '"init"');

    const worktreeDir = createTempDir('same-wt-');
    cleanupDir(worktreeDir);

    try {
      git(tempDir, 'worktree', 'add', worktreeDir, '-b', 'feature');
      expect(isSameRepository(tempDir, worktreeDir)).toBe(true);
    } finally {
      try {
        git(tempDir, 'worktree', 'remove', worktreeDir, '--force');
      } catch {
        cleanupDir(worktreeDir);
      }
    }
  });

  it('returns false for different repositories', () => {
    const dir1 = createTempDir('repo1-');
    const dir2 = createTempDir('repo2-');

    try {
      git(dir1, 'init');
      git(dir1, 'commit', '--allow-empty', '-m', '"init 1"');
      git(dir1, 'remote', 'add', 'origin', 'git@github.com:user/repo1.git');

      git(dir2, 'init');
      git(dir2, 'commit', '--allow-empty', '-m', '"init 2"');
      git(dir2, 'remote', 'add', 'origin', 'git@github.com:user/repo2.git');

      expect(isSameRepository(dir1, dir2)).toBe(false);
    } finally {
      cleanupDir(dir1);
      cleanupDir(dir2);
    }
  });
});
