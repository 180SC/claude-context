/**
 * Unit tests for the RepoRegistry class.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  RepoRegistry,
  RepoRecord,
  createRegistryFromSnapshot,
} from '../repo-registry';
import { resolveIdentity } from '../repo-identity';

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

// Helper to run git commands
function git(cwd: string, args: string[]): string {
  const env = {
    ...process.env,
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.com',
  };

  return execSync('git', {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
}

// Helper to run git with spawn to handle arguments properly
function gitExec(cwd: string, args: string[]): string {
  const allArgs = ['-c', 'commit.gpgsign=false', '-c', 'user.name=Test User', '-c', 'user.email=test@example.com', ...args];
  const env = {
    ...process.env,
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.com',
  };

  return execSync(`git ${allArgs.map(a => `"${a}"`).join(' ')}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    shell: '/bin/bash',
  }).trim();
}

// Helper to create a git repository
function createGitRepo(dirPath: string, remote?: string): void {
  gitExec(dirPath, ['init']);
  fs.writeFileSync(path.join(dirPath, 'README.md'), '# Test');
  gitExec(dirPath, ['add', 'README.md']);
  gitExec(dirPath, ['commit', '-m', 'Initial commit']);
  if (remote) {
    gitExec(dirPath, ['remote', 'add', 'origin', remote]);
  }
}

describe('RepoRegistry', () => {
  describe('constructor', () => {
    it('creates an empty registry', () => {
      const registry = new RepoRegistry();
      expect(registry.size).toBe(0);
      expect(registry.listAll()).toEqual([]);
    });

    it('initializes with existing records', () => {
      const records = new Map<string, RepoRecord>();
      records.set('repo-1', {
        canonicalId: 'repo-1',
        displayName: 'test-repo',
        identitySource: 'remote-url',
        knownPaths: ['/path/to/repo'],
        worktrees: [],
        isIndexed: true,
        collectionName: 'abc123',
      });

      const registry = new RepoRegistry(records);
      expect(registry.size).toBe(1);
      expect(registry.getByCanonicalId('repo-1')).toBeDefined();
    });
  });

  describe('resolve', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir('repo-registry-test-');
    });

    afterEach(() => {
      cleanupDir(tempDir);
    });

    it('resolves unregistered path as not found', () => {
      const registry = new RepoRegistry();
      const repoDir = path.join(tempDir, 'unregistered');
      fs.mkdirSync(repoDir);
      createGitRepo(repoDir, 'https://github.com/user/test-repo.git');

      const result = registry.resolve(repoDir);
      expect(result.found).toBe(false);
      expect(result.isNewPathForExistingRepo).toBe(false);
      expect(result.identity).toBeDefined();
    });

    it('resolves registered path as found', () => {
      const registry = new RepoRegistry();
      const repoDir = path.join(tempDir, 'registered');
      fs.mkdirSync(repoDir);
      createGitRepo(repoDir, 'https://github.com/user/test-repo.git');

      registry.register(repoDir, { isIndexed: true });

      const result = registry.resolve(repoDir);
      expect(result.found).toBe(true);
      expect(result.isNewPathForExistingRepo).toBe(false);
      expect(result.record).toBeDefined();
      expect(result.record?.isIndexed).toBe(true);
    });

    it('detects same repository from different path', () => {
      const registry = new RepoRegistry();
      const repoDir1 = path.join(tempDir, 'repo1');
      const repoDir2 = path.join(tempDir, 'repo2');
      fs.mkdirSync(repoDir1);
      fs.mkdirSync(repoDir2);

      // Create repo with same remote
      createGitRepo(repoDir1, 'https://github.com/user/same-repo.git');
      createGitRepo(repoDir2, 'https://github.com/user/same-repo.git');

      registry.register(repoDir1, { isIndexed: true });

      const result = registry.resolve(repoDir2);
      expect(result.found).toBe(true);
      expect(result.isNewPathForExistingRepo).toBe(true);
      expect(result.primaryPath).toBe(repoDir1);
    });
  });

  describe('register', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir('repo-registry-test-');
    });

    afterEach(() => {
      cleanupDir(tempDir);
    });

    it('registers a new repository', () => {
      const registry = new RepoRegistry();
      const repoDir = path.join(tempDir, 'new-repo');
      fs.mkdirSync(repoDir);
      createGitRepo(repoDir, 'https://github.com/user/new-repo.git');

      const record = registry.register(repoDir, {
        isIndexed: true,
        collectionName: 'test-collection',
        indexedFiles: 100,
        totalChunks: 500,
      });

      expect(record.canonicalId).toBeDefined();
      expect(record.displayName).toBe('new-repo');
      expect(record.isIndexed).toBe(true);
      expect(record.collectionName).toBe('test-collection');
      expect(record.indexedFiles).toBe(100);
      expect(record.totalChunks).toBe(500);
      expect(record.lastIndexed).toBeDefined();
    });

    it('updates existing repository record', () => {
      const registry = new RepoRegistry();
      const repoDir = path.join(tempDir, 'update-repo');
      fs.mkdirSync(repoDir);
      createGitRepo(repoDir, 'https://github.com/user/update-repo.git');

      registry.register(repoDir, { isIndexed: false });
      const updated = registry.register(repoDir, {
        isIndexed: true,
        collectionName: 'updated-collection',
      });

      expect(updated.isIndexed).toBe(true);
      expect(updated.collectionName).toBe('updated-collection');
      expect(registry.size).toBe(1); // Still just one repo
    });

    it('adds new path to existing repo record', () => {
      const registry = new RepoRegistry();
      const repoDir1 = path.join(tempDir, 'clone1');
      const repoDir2 = path.join(tempDir, 'clone2');
      fs.mkdirSync(repoDir1);
      fs.mkdirSync(repoDir2);

      createGitRepo(repoDir1, 'https://github.com/user/multi-path.git');
      createGitRepo(repoDir2, 'https://github.com/user/multi-path.git');

      registry.register(repoDir1);
      registry.register(repoDir2);

      expect(registry.size).toBe(1);
      const record = registry.getByPath(repoDir1);
      expect(record?.knownPaths).toContain(repoDir1);
      expect(record?.knownPaths).toContain(repoDir2);
    });
  });

  describe('isAlreadyIndexed', () => {
    it('returns false for unregistered identity', () => {
      const registry = new RepoRegistry();
      const identity = {
        canonicalId: 'unknown-id',
        displayName: 'test',
        identitySource: 'path-hash' as const,
        detectedPaths: [],
        isGitRepo: false,
        isWorktree: false,
      };

      expect(registry.isAlreadyIndexed(identity)).toBe(false);
    });

    it('returns true for indexed repository', () => {
      const records = new Map<string, RepoRecord>();
      records.set('indexed-repo', {
        canonicalId: 'indexed-repo',
        displayName: 'test',
        identitySource: 'remote-url',
        knownPaths: ['/path/to/repo'],
        worktrees: [],
        isIndexed: true,
      });

      const registry = new RepoRegistry(records);
      const identity = {
        canonicalId: 'indexed-repo',
        displayName: 'test',
        identitySource: 'remote-url' as const,
        detectedPaths: [],
        isGitRepo: true,
        isWorktree: false,
      };

      expect(registry.isAlreadyIndexed(identity)).toBe(true);
    });
  });

  describe('markIndexed and markNotIndexed', () => {
    it('marks repository as indexed', () => {
      const records = new Map<string, RepoRecord>();
      records.set('mark-test', {
        canonicalId: 'mark-test',
        displayName: 'test',
        identitySource: 'remote-url',
        knownPaths: ['/path/to/repo'],
        worktrees: [],
        isIndexed: false,
      });

      const registry = new RepoRegistry(records);
      registry.markIndexed('mark-test', {
        collectionName: 'new-collection',
        indexedFiles: 50,
        totalChunks: 200,
      });

      const record = registry.getByCanonicalId('mark-test');
      expect(record?.isIndexed).toBe(true);
      expect(record?.collectionName).toBe('new-collection');
      expect(record?.indexedFiles).toBe(50);
      expect(record?.totalChunks).toBe(200);
      expect(record?.lastIndexed).toBeDefined();
    });

    it('marks repository as not indexed', () => {
      const records = new Map<string, RepoRecord>();
      records.set('mark-test', {
        canonicalId: 'mark-test',
        displayName: 'test',
        identitySource: 'remote-url',
        knownPaths: ['/path/to/repo'],
        worktrees: [],
        isIndexed: true,
        collectionName: 'old-collection',
        indexedFiles: 100,
        totalChunks: 500,
      });

      const registry = new RepoRegistry(records);
      registry.markNotIndexed('mark-test');

      const record = registry.getByCanonicalId('mark-test');
      expect(record?.isIndexed).toBe(false);
      expect(record?.collectionName).toBeUndefined();
      expect(record?.indexedFiles).toBeUndefined();
      expect(record?.totalChunks).toBeUndefined();
    });
  });

  describe('listAll and listIndexed', () => {
    it('lists all repositories', () => {
      const records = new Map<string, RepoRecord>();
      records.set('repo-1', {
        canonicalId: 'repo-1',
        displayName: 'test1',
        identitySource: 'remote-url',
        knownPaths: ['/path/1'],
        worktrees: [],
        isIndexed: true,
      });
      records.set('repo-2', {
        canonicalId: 'repo-2',
        displayName: 'test2',
        identitySource: 'initial-commit',
        knownPaths: ['/path/2'],
        worktrees: [],
        isIndexed: false,
      });

      const registry = new RepoRegistry(records);
      expect(registry.listAll()).toHaveLength(2);
    });

    it('lists only indexed repositories', () => {
      const records = new Map<string, RepoRecord>();
      records.set('repo-1', {
        canonicalId: 'repo-1',
        displayName: 'test1',
        identitySource: 'remote-url',
        knownPaths: ['/path/1'],
        worktrees: [],
        isIndexed: true,
      });
      records.set('repo-2', {
        canonicalId: 'repo-2',
        displayName: 'test2',
        identitySource: 'initial-commit',
        knownPaths: ['/path/2'],
        worktrees: [],
        isIndexed: false,
      });

      const registry = new RepoRegistry(records);
      const indexed = registry.listIndexed();
      expect(indexed).toHaveLength(1);
      expect(indexed[0].canonicalId).toBe('repo-1');
    });
  });

  describe('removePath and removeByCanonicalId', () => {
    it('removes a path from a repository', () => {
      const records = new Map<string, RepoRecord>();
      records.set('multi-path-repo', {
        canonicalId: 'multi-path-repo',
        displayName: 'test',
        identitySource: 'remote-url',
        knownPaths: ['/path/1', '/path/2'],
        worktrees: [],
        isIndexed: true,
      });

      const registry = new RepoRegistry(records);
      expect(registry.removePath('/path/1')).toBe(true);

      const record = registry.getByCanonicalId('multi-path-repo');
      expect(record?.knownPaths).toEqual(['/path/2']);
    });

    it('removes entire repo when last path is removed', () => {
      const records = new Map<string, RepoRecord>();
      records.set('single-path-repo', {
        canonicalId: 'single-path-repo',
        displayName: 'test',
        identitySource: 'remote-url',
        knownPaths: ['/path/only'],
        worktrees: [],
        isIndexed: true,
      });

      const registry = new RepoRegistry(records);
      expect(registry.removePath('/path/only')).toBe(true);
      expect(registry.size).toBe(0);
    });

    it('removes repository by canonical ID', () => {
      const records = new Map<string, RepoRecord>();
      records.set('to-remove', {
        canonicalId: 'to-remove',
        displayName: 'test',
        identitySource: 'remote-url',
        knownPaths: ['/path/1', '/path/2'],
        worktrees: [],
        isIndexed: true,
      });

      const registry = new RepoRegistry(records);
      expect(registry.removeByCanonicalId('to-remove')).toBe(true);
      expect(registry.size).toBe(0);
      expect(registry.getByPath('/path/1')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('clears all registry data', () => {
      const records = new Map<string, RepoRecord>();
      records.set('repo-1', {
        canonicalId: 'repo-1',
        displayName: 'test1',
        identitySource: 'remote-url',
        knownPaths: ['/path/1'],
        worktrees: [],
        isIndexed: true,
      });

      const registry = new RepoRegistry(records);
      registry.clear();

      expect(registry.size).toBe(0);
      expect(registry.listAll()).toEqual([]);
    });
  });
});

describe('createRegistryFromSnapshot', () => {
  it('creates registry from v3 snapshot format', () => {
    const snapshot = {
      'github.com_user_repo': {
        displayName: 'repo',
        remoteUrl: 'github.com/user/repo',
        identitySource: 'remote-url' as const,
        knownPaths: ['/home/user/repo', '/home/user/repo-clone'],
        worktrees: [],
        branches: {
          default: {
            status: 'indexed',
            indexedFiles: 100,
            totalChunks: 500,
          },
        },
        defaultBranch: 'default',
        lastIndexed: '2024-01-01T00:00:00.000Z',
        collectionName: 'code_chunks_abc123',
      },
      'github.com_org_project': {
        displayName: 'project',
        remoteUrl: 'github.com/org/project',
        identitySource: 'remote-url' as const,
        knownPaths: ['/home/user/project'],
        worktrees: [],
        branches: {
          default: {
            status: 'stale',
            indexedFiles: 50,
            totalChunks: 200,
          },
        },
        defaultBranch: 'default',
        lastIndexed: '2024-01-01T00:00:00.000Z',
      },
    };

    const registry = createRegistryFromSnapshot(snapshot);

    expect(registry.size).toBe(2);

    const indexed = registry.listIndexed();
    expect(indexed).toHaveLength(1);
    expect(indexed[0].displayName).toBe('repo');

    const repo1 = registry.getByCanonicalId('github.com_user_repo');
    expect(repo1?.isIndexed).toBe(true);
    expect(repo1?.collectionName).toBe('code_chunks_abc123');
    expect(repo1?.indexedFiles).toBe(100);
    expect(repo1?.knownPaths).toHaveLength(2);

    const repo2 = registry.getByCanonicalId('github.com_org_project');
    expect(repo2?.isIndexed).toBe(false);
  });

  it('handles empty snapshot', () => {
    const registry = createRegistryFromSnapshot({});
    expect(registry.size).toBe(0);
  });
});
