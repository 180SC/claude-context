/**
 * Repository identity detection module.
 *
 * This module determines the canonical identity of a git repository given a filesystem path.
 * It handles worktrees, clones, and various remote URL formats to ensure that different
 * checkouts of the same repository resolve to the same canonical identity.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import {
  detectGitRepo,
  getRemoteOriginUrl,
  getInitialCommitSha,
  normalizeGitUrl,
  listWorktrees,
  getCommonGitDir,
  GitDetectionResult,
} from './git-utils';

/**
 * Represents the canonical identity of a git repository.
 */
export interface RepoIdentity {
  /**
   * The canonical identifier for the repository.
   * This is derived from (in order of preference):
   * 1. Normalized remote origin URL (e.g., "github.com/user/repo")
   * 2. SHA of the initial commit
   * 3. MD5 hash of the resolved path (fallback for non-git directories)
   */
  canonicalId: string;

  /**
   * The normalized remote origin URL, if available.
   * Format: "host/user/repo" (e.g., "github.com/user/repo")
   */
  remoteUrl?: string;

  /**
   * For worktrees: the path to the main worktree.
   * For regular repos: undefined.
   */
  mainWorktreePath?: string;

  /**
   * All known filesystem paths associated with this repository.
   * Includes the main repo and all worktrees.
   */
  detectedPaths: string[];

  /**
   * The display name for the repository.
   * Derived from the remote URL or directory name.
   */
  displayName: string;

  /**
   * The method used to generate the canonical ID.
   */
  identitySource: 'remote-url' | 'initial-commit' | 'path-hash';

  /**
   * Whether the path is inside a git repository.
   */
  isGitRepo: boolean;

  /**
   * Whether the resolved path is a worktree.
   */
  isWorktree: boolean;

  /**
   * The root directory of the repository at the resolved path.
   */
  repoRoot?: string;
}

/**
 * Options for resolving repository identity.
 */
export interface ResolveIdentityOptions {
  /**
   * Whether to discover and include all worktrees in detectedPaths.
   * Default: true
   */
  includeWorktrees?: boolean;
}

/**
 * Generate a canonical ID from a normalized remote URL.
 */
function canonicalIdFromUrl(normalizedUrl: string): string {
  return crypto.createHash('md5').update(normalizedUrl).digest('hex');
}

/**
 * Generate a canonical ID from the initial commit SHA.
 */
function canonicalIdFromCommit(commitSha: string): string {
  // Prefix with 'commit-' to distinguish from URL-based IDs
  return crypto.createHash('md5').update(`commit:${commitSha}`).digest('hex');
}

/**
 * Generate a canonical ID from a filesystem path (fallback).
 */
function canonicalIdFromPath(resolvedPath: string): string {
  return crypto.createHash('md5').update(resolvedPath).digest('hex');
}

/**
 * Extract a display name from a remote URL or path.
 */
function extractDisplayName(remoteUrl: string | null, repoPath: string): string {
  if (remoteUrl) {
    // Get the repo name from the URL (last segment)
    const parts = remoteUrl.split('/');
    return parts[parts.length - 1] || remoteUrl;
  }

  // Fall back to directory name
  return path.basename(repoPath);
}

/**
 * Resolve the canonical identity of a git repository at the given path.
 *
 * This function determines a stable identifier for a repository that is the same
 * regardless of filesystem path, clone location, or worktree. It handles:
 *
 * - Regular git repositories
 * - Git worktrees (linked working trees)
 * - Repositories without remotes (uses initial commit SHA)
 * - Non-git directories (falls back to path-based hash)
 *
 * @param targetPath The filesystem path to resolve
 * @param options Options for identity resolution
 * @returns The resolved repository identity
 *
 * @example
 * // Two worktrees of the same repo return the same canonicalId
 * const id1 = await resolveIdentity('/home/user/myrepo');
 * const id2 = await resolveIdentity('/home/user/myrepo-feature');
 * console.log(id1.canonicalId === id2.canonicalId); // true
 *
 * @example
 * // Two clones of the same GitHub repo return the same canonicalId
 * const id1 = await resolveIdentity('/home/user/myrepo');
 * const id2 = await resolveIdentity('/work/projects/myrepo-copy');
 * console.log(id1.canonicalId === id2.canonicalId); // true (if same remote)
 */
export function resolveIdentity(
  targetPath: string,
  options: ResolveIdentityOptions = {}
): RepoIdentity {
  const { includeWorktrees = true } = options;
  const resolvedPath = path.resolve(targetPath);

  // Detect git repository
  const gitInfo: GitDetectionResult = detectGitRepo(resolvedPath);

  if (!gitInfo.isGitRepo || !gitInfo.repoRoot) {
    // Not a git repository - fall back to path-based identity
    return {
      canonicalId: canonicalIdFromPath(resolvedPath),
      detectedPaths: [resolvedPath],
      displayName: path.basename(resolvedPath),
      identitySource: 'path-hash',
      isGitRepo: false,
      isWorktree: false,
    };
  }

  const repoRoot = gitInfo.repoRoot;
  const detectedPaths: string[] = [repoRoot];
  let mainWorktreePath: string | undefined;

  // If this is a worktree, find the main worktree path
  if (gitInfo.isWorktree && gitInfo.mainGitDir) {
    // The main worktree is the parent of the .git directory
    mainWorktreePath = path.dirname(gitInfo.mainGitDir);
    if (!detectedPaths.includes(mainWorktreePath)) {
      detectedPaths.push(mainWorktreePath);
    }
  }

  // Discover all worktrees if requested
  if (includeWorktrees) {
    const worktrees = listWorktrees(repoRoot);
    for (const wt of worktrees) {
      if (!detectedPaths.includes(wt)) {
        detectedPaths.push(wt);
      }
    }
  }

  // Try to get remote origin URL (primary method for canonical ID)
  const rawRemoteUrl = getRemoteOriginUrl(repoRoot);
  const normalizedUrl = rawRemoteUrl ? normalizeGitUrl(rawRemoteUrl) : null;

  if (normalizedUrl) {
    return {
      canonicalId: canonicalIdFromUrl(normalizedUrl),
      remoteUrl: normalizedUrl,
      mainWorktreePath,
      detectedPaths,
      displayName: extractDisplayName(normalizedUrl, repoRoot),
      identitySource: 'remote-url',
      isGitRepo: true,
      isWorktree: gitInfo.isWorktree,
      repoRoot,
    };
  }

  // Fallback: use initial commit SHA
  const initialCommit = getInitialCommitSha(repoRoot);

  if (initialCommit) {
    return {
      canonicalId: canonicalIdFromCommit(initialCommit),
      mainWorktreePath,
      detectedPaths,
      displayName: extractDisplayName(null, repoRoot),
      identitySource: 'initial-commit',
      isGitRepo: true,
      isWorktree: gitInfo.isWorktree,
      repoRoot,
    };
  }

  // Last resort: path-based hash (git repo with no commits)
  return {
    canonicalId: canonicalIdFromPath(repoRoot),
    mainWorktreePath,
    detectedPaths,
    displayName: extractDisplayName(null, repoRoot),
    identitySource: 'path-hash',
    isGitRepo: true,
    isWorktree: gitInfo.isWorktree,
    repoRoot,
  };
}

/**
 * Resolve identity specifically from a git remote URL.
 * Useful for identifying repositories by their remote URL without having a local clone.
 *
 * @param remoteUrl The git remote URL
 * @returns The canonical ID and normalized URL, or null if the URL can't be normalized
 */
export function resolveIdentityFromUrl(remoteUrl: string): { canonicalId: string; normalizedUrl: string } | null {
  const normalizedUrl = normalizeGitUrl(remoteUrl);
  if (!normalizedUrl) {
    return null;
  }

  return {
    canonicalId: canonicalIdFromUrl(normalizedUrl),
    normalizedUrl,
  };
}

/**
 * Check if two paths resolve to the same repository.
 *
 * @param path1 First filesystem path
 * @param path2 Second filesystem path
 * @returns True if both paths are part of the same repository
 */
export function isSameRepository(path1: string, path2: string): boolean {
  const id1 = resolveIdentity(path1);
  const id2 = resolveIdentity(path2);
  return id1.canonicalId === id2.canonicalId;
}
