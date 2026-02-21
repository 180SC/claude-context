/**
 * Git utility functions for repository identity detection.
 *
 * These utilities handle git command execution and URL normalization
 * for determining canonical repository identity across worktrees and clones.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Result of detecting a git repository at a path.
 */
export interface GitDetectionResult {
  /** Whether the path is inside a git repository */
  isGitRepo: boolean;
  /** The root directory of the git repository (where .git is) */
  repoRoot?: string;
  /** Whether this is a worktree (has .git file instead of directory) */
  isWorktree: boolean;
  /** For worktrees: the path to the main worktree's .git directory */
  mainGitDir?: string;
  /** The path to the .git directory or file */
  gitPath?: string;
}

/**
 * Execute a git command in the specified directory.
 * Returns null if the command fails.
 */
export function execGitCommand(command: string, cwd: string): string | null {
  try {
    const result = execSync(command, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000, // 10 second timeout
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Find the .git directory or file by walking up from the given path.
 * Returns the path to .git and whether it's a file (worktree) or directory (regular repo).
 */
export function findGitPath(startPath: string): { gitPath: string; isFile: boolean } | null {
  let currentPath = path.resolve(startPath);
  const root = path.parse(currentPath).root;

  while (currentPath !== root) {
    const gitPath = path.join(currentPath, '.git');

    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) {
        return { gitPath, isFile: false };
      } else if (stat.isFile()) {
        return { gitPath, isFile: true };
      }
    } catch {
      // .git doesn't exist at this level, continue walking up
    }

    currentPath = path.dirname(currentPath);
  }

  return null;
}

/**
 * Detect git repository information for a given path.
 * Handles both regular repositories and worktrees.
 */
export function detectGitRepo(targetPath: string): GitDetectionResult {
  const resolvedPath = path.resolve(targetPath);

  // Find .git by walking up the directory tree
  const gitInfo = findGitPath(resolvedPath);

  if (!gitInfo) {
    return { isGitRepo: false, isWorktree: false };
  }

  const repoRoot = path.dirname(gitInfo.gitPath);

  if (!gitInfo.isFile) {
    // Regular repository with .git directory
    return {
      isGitRepo: true,
      repoRoot,
      isWorktree: false,
      gitPath: gitInfo.gitPath,
    };
  }

  // Worktree: .git is a file containing path to main repo's .git/worktrees/<name>
  try {
    const gitFileContent = fs.readFileSync(gitInfo.gitPath, 'utf-8').trim();
    // Format: "gitdir: /path/to/main/.git/worktrees/<worktree-name>"
    const match = gitFileContent.match(/^gitdir:\s*(.+)$/);

    if (match) {
      const worktreeGitDir = match[1];
      // The main .git directory is two levels up from worktrees/<name>
      // e.g., /main/.git/worktrees/feature -> /main/.git
      const mainGitDir = path.resolve(worktreeGitDir, '..', '..');

      return {
        isGitRepo: true,
        repoRoot,
        isWorktree: true,
        mainGitDir,
        gitPath: gitInfo.gitPath,
      };
    }
  } catch {
    // Failed to read worktree .git file
  }

  // Fallback: treat as regular repo if we can't parse the worktree file
  return {
    isGitRepo: true,
    repoRoot,
    isWorktree: false,
    gitPath: gitInfo.gitPath,
  };
}

/**
 * Get the remote origin URL for a git repository.
 * Returns null if no origin remote is configured.
 */
export function getRemoteOriginUrl(repoPath: string): string | null {
  return execGitCommand('git config --get remote.origin.url', repoPath);
}

/**
 * Get the SHA of the initial commit (root commit) in the repository.
 * Returns null if the repo has no commits or git command fails.
 */
export function getInitialCommitSha(repoPath: string): string | null {
  return execGitCommand('git rev-list --max-parents=0 HEAD', repoPath);
}

/**
 * Get the current branch name.
 * Returns null if in detached HEAD state or git command fails.
 */
export function getCurrentBranch(repoPath: string): string | null {
  return execGitCommand('git rev-parse --abbrev-ref HEAD', repoPath);
}

/**
 * Get the current commit hash.
 * Returns null if no commits or git command fails.
 */
export function getCurrentCommitHash(repoPath: string): string | null {
  return execGitCommand('git rev-parse HEAD', repoPath);
}

/**
 * Normalize a git remote URL to a canonical form.
 *
 * Handles the following URL formats:
 * - git@github.com:user/repo.git -> github.com/user/repo
 * - ssh://git@github.com/user/repo.git -> github.com/user/repo
 * - https://github.com/user/repo.git -> github.com/user/repo
 * - https://github.com/user/repo -> github.com/user/repo
 * - git://github.com/user/repo.git -> github.com/user/repo
 * - http://github.com/user/repo.git -> github.com/user/repo
 *
 * @param url The git remote URL to normalize
 * @returns The normalized URL in the form "host/user/repo", or null if parsing fails
 */
export function normalizeGitUrl(url: string): string | null {
  if (!url || typeof url !== 'string') {
    return null;
  }

  let normalized = url.trim();

  // Handle SSH format: git@host:user/repo.git
  const sshMatch = normalized.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const host = sshMatch[1];
    let path = sshMatch[2];
    // Remove .git suffix if present
    path = path.replace(/\.git$/, '');
    return `${host}/${path}`;
  }

  // Handle URL formats: ssh://, https://, http://, git://
  const urlMatch = normalized.match(/^(?:ssh|https?|git):\/\/(?:[^@]+@)?([^/]+)\/(.+)$/);
  if (urlMatch) {
    const host = urlMatch[1];
    let path = urlMatch[2];
    // Remove .git suffix if present
    path = path.replace(/\.git$/, '');
    return `${host}/${path}`;
  }

  // Handle file:// protocol (local repos) - return null as these shouldn't be normalized
  if (normalized.startsWith('file://')) {
    return null;
  }

  // If we can't parse the URL, return null
  return null;
}

/**
 * Check if a path is a bare git repository.
 */
export function isBareRepo(repoPath: string): boolean {
  const result = execGitCommand('git rev-parse --is-bare-repository', repoPath);
  return result === 'true';
}

/**
 * Get the common git directory (shared object store).
 * For regular repos, this is the .git directory.
 * For worktrees, this is the main repo's .git directory.
 */
export function getCommonGitDir(repoPath: string): string | null {
  return execGitCommand('git rev-parse --git-common-dir', repoPath);
}

/**
 * List all worktrees for a repository.
 * Returns an array of worktree paths, or empty array if git command fails.
 */
export function listWorktrees(repoPath: string): string[] {
  const result = execGitCommand('git worktree list --porcelain', repoPath);
  if (!result) {
    return [];
  }

  const worktrees: string[] = [];
  const lines = result.split('\n');

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      worktrees.push(line.substring('worktree '.length));
    }
  }

  return worktrees;
}
