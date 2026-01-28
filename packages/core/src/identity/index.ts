/**
 * Identity module for repository identity detection.
 *
 * This module provides utilities for determining the canonical identity of git repositories,
 * handling worktrees, clones, and various remote URL formats.
 *
 * @example
 * import { resolveIdentity, isSameRepository } from '@zilliz/claude-context-core';
 *
 * // Check if two paths are the same repository
 * const identity = resolveIdentity('/path/to/repo');
 * console.log(identity.canonicalId); // Stable ID regardless of path
 *
 * // Compare two paths
 * if (isSameRepository('/repo', '/repo-worktree')) {
 *   console.log('Same repository!');
 * }
 */

export * from './repo-identity';
export * from './git-utils';
export * from './collection-migrator';
