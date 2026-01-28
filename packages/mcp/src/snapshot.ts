import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
    CodebaseSnapshot,
    CodebaseSnapshotV1,
    CodebaseSnapshotV2,
    CodebaseSnapshotV3,
    CodebaseInfo,
    CodebaseInfoIndexing,
    CodebaseInfoIndexed,
    CodebaseInfoIndexFailed,
    RepoSnapshot,
    BranchSnapshot,
} from "./config.js";
import { resolveIdentity, RepoIdentity } from "@zilliz/claude-context-core";

export class SnapshotManager {
    private snapshotFilePath: string;
    private indexedCodebases: string[] = [];
    private indexingCodebases: Map<string, number> = new Map(); // Map of codebase path to progress percentage
    private codebaseFileCount: Map<string, number> = new Map(); // Map of codebase path to indexed file count
    private codebaseInfoMap: Map<string, CodebaseInfo> = new Map(); // Map of codebase path to complete info

    // V3 state: canonical-ID-keyed repository records
    private repositories: Map<string, RepoSnapshot> = new Map(); // canonicalId -> RepoSnapshot
    private pathToCanonicalId: Map<string, string> = new Map(); // path -> canonicalId (for quick lookups)

    /**
     * Create a new SnapshotManager.
     * @param customSnapshotPath Optional custom snapshot file path (for testing)
     */
    constructor(customSnapshotPath?: string) {
        // Initialize snapshot file path
        this.snapshotFilePath = customSnapshotPath || path.join(os.homedir(), '.context', 'mcp-codebase-snapshot.json');
    }

    /**
     * Check if snapshot is v2 format
     */
    private isV2Format(snapshot: any): snapshot is CodebaseSnapshotV2 {
        return snapshot && snapshot.formatVersion === 'v2';
    }

    /**
     * Check if snapshot is v3 format
     */
    private isV3Format(snapshot: any): snapshot is CodebaseSnapshotV3 {
        return snapshot && snapshot.formatVersion === 'v3';
    }

    /**
     * Safely resolve git identity for a path.
     * Returns null if resolution fails (e.g., git not available, invalid path).
     */
    private safeResolveIdentity(codebasePath: string): RepoIdentity | null {
        try {
            return resolveIdentity(codebasePath);
        } catch (error) {
            console.warn(`[SNAPSHOT-DEBUG] Failed to resolve identity for ${codebasePath}:`, error);
            return null;
        }
    }

    /**
     * Convert v1 format to v3 internal state
     */
    private migrateV1ToV3(snapshot: CodebaseSnapshotV1): void {
        console.log('[SNAPSHOT-DEBUG] Migrating v1 format to v3');

        const now = new Date().toISOString();
        const repoGroups = new Map<string, { identity: RepoIdentity; paths: string[]; info: CodebaseInfo }>();

        // Process indexed codebases
        for (const codebasePath of snapshot.indexedCodebases || []) {
            if (!fs.existsSync(codebasePath)) {
                console.warn(`[SNAPSHOT-DEBUG] Codebase no longer exists, skipping: ${codebasePath}`);
                continue;
            }

            const identity = this.safeResolveIdentity(codebasePath);
            const canonicalId = identity?.canonicalId || this.pathBasedCanonicalId(codebasePath);

            const info: CodebaseInfoIndexed = {
                status: 'indexed',
                indexedFiles: 0,
                totalChunks: 0,
                indexStatus: 'completed',
                lastUpdated: now,
            };

            if (repoGroups.has(canonicalId)) {
                const group = repoGroups.get(canonicalId)!;
                if (!group.paths.includes(codebasePath)) {
                    group.paths.push(codebasePath);
                }
            } else {
                repoGroups.set(canonicalId, {
                    identity: identity || this.createFallbackIdentity(codebasePath),
                    paths: [codebasePath],
                    info,
                });
            }
        }

        // Convert groups to v3 repositories
        this.buildV3StateFromGroups(repoGroups);
    }

    /**
     * Convert v2 format to v3 internal state
     */
    private migrateV2ToV3(snapshot: CodebaseSnapshotV2): void {
        console.log('[SNAPSHOT-DEBUG] Migrating v2 format to v3');

        const repoGroups = new Map<string, { identity: RepoIdentity; paths: string[]; info: CodebaseInfo }>();

        for (const [codebasePath, info] of Object.entries(snapshot.codebases)) {
            if (!fs.existsSync(codebasePath)) {
                console.warn(`[SNAPSHOT-DEBUG] Codebase no longer exists, skipping: ${codebasePath}`);
                continue;
            }

            const identity = this.safeResolveIdentity(codebasePath);
            const canonicalId = identity?.canonicalId || this.pathBasedCanonicalId(codebasePath);

            if (repoGroups.has(canonicalId)) {
                const group = repoGroups.get(canonicalId)!;
                if (!group.paths.includes(codebasePath)) {
                    group.paths.push(codebasePath);
                }
                // Keep the most recent/complete info
                if (info.status === 'indexed' && group.info.status !== 'indexed') {
                    group.info = info;
                }
            } else {
                repoGroups.set(canonicalId, {
                    identity: identity || this.createFallbackIdentity(codebasePath),
                    paths: [codebasePath],
                    info,
                });
            }
        }

        // Convert groups to v3 repositories
        this.buildV3StateFromGroups(repoGroups);
    }

    /**
     * Load v3 format directly
     */
    private loadV3Format(snapshot: CodebaseSnapshotV3): void {
        console.log('[SNAPSHOT-DEBUG] Loading v3 format snapshot');

        this.repositories.clear();
        this.pathToCanonicalId.clear();
        this.indexedCodebases = [];
        this.indexingCodebases.clear();
        this.codebaseFileCount.clear();
        this.codebaseInfoMap.clear();

        for (const [canonicalId, repoSnapshot] of Object.entries(snapshot.repositories)) {
            // Validate that at least one path still exists
            const validPaths = repoSnapshot.knownPaths.filter(p => fs.existsSync(p));
            if (validPaths.length === 0) {
                console.warn(`[SNAPSHOT-DEBUG] No valid paths for repo ${canonicalId}, skipping`);
                continue;
            }

            // Update the repo snapshot with valid paths only
            const updatedSnapshot: RepoSnapshot = {
                ...repoSnapshot,
                knownPaths: validPaths,
                worktrees: repoSnapshot.worktrees.filter(w => validPaths.includes(w)),
            };

            this.repositories.set(canonicalId, updatedSnapshot);

            // Build path lookup
            for (const pathItem of validPaths) {
                this.pathToCanonicalId.set(pathItem, canonicalId);
            }

            // Populate legacy path-based state for backward compatibility
            this.populateLegacyStateFromRepo(canonicalId, updatedSnapshot);
        }

        console.log(`[SNAPSHOT-DEBUG] Loaded ${this.repositories.size} repositories, ${this.indexedCodebases.length} indexed paths`);
    }

    /**
     * Build v3 internal state from grouped repositories
     */
    private buildV3StateFromGroups(
        groups: Map<string, { identity: RepoIdentity; paths: string[]; info: CodebaseInfo }>
    ): void {
        this.repositories.clear();
        this.pathToCanonicalId.clear();
        this.indexedCodebases = [];
        this.indexingCodebases.clear();
        this.codebaseFileCount.clear();
        this.codebaseInfoMap.clear();

        const now = new Date().toISOString();

        for (const [canonicalId, group] of groups) {
            const { identity, paths, info } = group;

            // Determine worktrees
            const worktrees = paths.filter(p => {
                const pathIdentity = this.safeResolveIdentity(p);
                return pathIdentity?.isWorktree || false;
            });

            // Create branch snapshot from the codebase info
            const branchSnapshot: BranchSnapshot = {
                status: info.status === 'indexed' ? 'indexed' :
                        info.status === 'indexing' ? 'indexing' : 'indexfailed',
                indexedFiles: 'indexedFiles' in info ? info.indexedFiles : 0,
                totalChunks: 'totalChunks' in info ? info.totalChunks : 0,
                lastIndexed: info.lastUpdated,
                indexingPercentage: 'indexingPercentage' in info ? info.indexingPercentage : undefined,
                errorMessage: 'errorMessage' in info ? info.errorMessage : undefined,
            };

            const repoSnapshot: RepoSnapshot = {
                displayName: identity.displayName,
                remoteUrl: identity.remoteUrl,
                identitySource: identity.identitySource,
                knownPaths: paths,
                worktrees,
                branches: { 'default': branchSnapshot },
                defaultBranch: 'default',
                lastIndexed: now,
            };

            this.repositories.set(canonicalId, repoSnapshot);

            // Build path lookup
            for (const pathItem of paths) {
                this.pathToCanonicalId.set(pathItem, canonicalId);
            }

            // Populate legacy state
            this.populateLegacyStateFromRepo(canonicalId, repoSnapshot);
        }

        console.log(`[SNAPSHOT-DEBUG] Migrated to v3: ${this.repositories.size} repositories, ${this.indexedCodebases.length} indexed paths`);
    }

    /**
     * Populate legacy path-based state from a v3 repository record
     */
    private populateLegacyStateFromRepo(canonicalId: string, repo: RepoSnapshot): void {
        const defaultBranch = repo.branches[repo.defaultBranch || 'default'];
        if (!defaultBranch) return;

        for (const pathItem of repo.knownPaths) {
            // Create CodebaseInfo from branch snapshot
            let info: CodebaseInfo;
            if (defaultBranch.status === 'indexed') {
                info = {
                    status: 'indexed',
                    indexedFiles: defaultBranch.indexedFiles,
                    totalChunks: defaultBranch.totalChunks,
                    indexStatus: 'completed',
                    lastUpdated: defaultBranch.lastIndexed,
                };
                if (!this.indexedCodebases.includes(pathItem)) {
                    this.indexedCodebases.push(pathItem);
                }
                this.codebaseFileCount.set(pathItem, defaultBranch.indexedFiles);
            } else if (defaultBranch.status === 'indexing') {
                info = {
                    status: 'indexing',
                    indexingPercentage: defaultBranch.indexingPercentage || 0,
                    lastUpdated: defaultBranch.lastIndexed,
                };
                this.indexingCodebases.set(pathItem, defaultBranch.indexingPercentage || 0);
            } else {
                info = {
                    status: 'indexfailed',
                    errorMessage: defaultBranch.errorMessage || 'Unknown error',
                    lastUpdated: defaultBranch.lastIndexed,
                };
            }

            this.codebaseInfoMap.set(pathItem, info);
        }
    }

    /**
     * Create a path-based canonical ID (fallback when git identity fails)
     */
    private pathBasedCanonicalId(codebasePath: string): string {
        const crypto = require('crypto');
        return crypto.createHash('md5').update(path.resolve(codebasePath)).digest('hex');
    }

    /**
     * Create a fallback identity when git resolution fails
     */
    private createFallbackIdentity(codebasePath: string): RepoIdentity {
        return {
            canonicalId: this.pathBasedCanonicalId(codebasePath),
            detectedPaths: [codebasePath],
            displayName: path.basename(codebasePath),
            identitySource: 'path-hash',
            isGitRepo: false,
            isWorktree: false,
        };
    }

    /**
     * Convert v1 format to internal state
     */
    private loadV1Format(snapshot: CodebaseSnapshotV1): void {
        console.log('[SNAPSHOT-DEBUG] Loading v1 format snapshot');

        // Validate that the codebases still exist
        const validCodebases: string[] = [];
        for (const codebasePath of snapshot.indexedCodebases) {
            if (fs.existsSync(codebasePath)) {
                validCodebases.push(codebasePath);
                console.log(`[SNAPSHOT-DEBUG] Validated codebase: ${codebasePath}`);
            } else {
                console.warn(`[SNAPSHOT-DEBUG] Codebase no longer exists, removing: ${codebasePath}`);
            }
        }

        // Handle indexing codebases - treat them as not indexed since they were interrupted
        let indexingCodebasesList: string[] = [];
        if (Array.isArray(snapshot.indexingCodebases)) {
            // Legacy format: string[]
            indexingCodebasesList = snapshot.indexingCodebases;
            console.log(`[SNAPSHOT-DEBUG] Found legacy indexingCodebases array format with ${indexingCodebasesList.length} entries`);
        } else if (snapshot.indexingCodebases && typeof snapshot.indexingCodebases === 'object') {
            // New format: Record<string, number>
            indexingCodebasesList = Object.keys(snapshot.indexingCodebases);
            console.log(`[SNAPSHOT-DEBUG] Found new indexingCodebases object format with ${indexingCodebasesList.length} entries`);
        }

        for (const codebasePath of indexingCodebasesList) {
            if (fs.existsSync(codebasePath)) {
                console.warn(`[SNAPSHOT-DEBUG] Found interrupted indexing codebase: ${codebasePath}. Treating as not indexed.`);
                // Don't add to validIndexingCodebases - treat as not indexed
            } else {
                console.warn(`[SNAPSHOT-DEBUG] Interrupted indexing codebase no longer exists: ${codebasePath}`);
            }
        }

        // Restore state - only fully indexed codebases
        this.indexedCodebases = validCodebases;
        this.indexingCodebases = new Map(); // Reset indexing codebases since they were interrupted
        this.codebaseFileCount = new Map(); // No file count info in v1 format

        // Populate codebaseInfoMap for v1 indexed codebases (with minimal info)
        this.codebaseInfoMap = new Map();
        const now = new Date().toISOString();
        for (const codebasePath of validCodebases) {
            const info: CodebaseInfoIndexed = {
                status: 'indexed',
                indexedFiles: 0, // Unknown in v1 format
                totalChunks: 0,  // Unknown in v1 format
                indexStatus: 'completed', // Assume completed for v1 format
                lastUpdated: now
            };
            this.codebaseInfoMap.set(codebasePath, info);
        }
    }

    /**
 * Convert v2 format to internal state
 */
    private loadV2Format(snapshot: CodebaseSnapshotV2): void {
        console.log('[SNAPSHOT-DEBUG] Loading v2 format snapshot');

        const validIndexedCodebases: string[] = [];
        const validIndexingCodebases = new Map<string, number>();
        const validFileCount = new Map<string, number>();
        const validCodebaseInfoMap = new Map<string, CodebaseInfo>();

        for (const [codebasePath, info] of Object.entries(snapshot.codebases)) {
            if (!fs.existsSync(codebasePath)) {
                console.warn(`[SNAPSHOT-DEBUG] Codebase no longer exists, removing: ${codebasePath}`);
                continue;
            }

            // Store the complete info for this codebase
            validCodebaseInfoMap.set(codebasePath, info);

            if (info.status === 'indexed') {
                validIndexedCodebases.push(codebasePath);
                if ('indexedFiles' in info) {
                    validFileCount.set(codebasePath, info.indexedFiles);
                }
                console.log(`[SNAPSHOT-DEBUG] Validated indexed codebase: ${codebasePath} (${info.indexedFiles || 'unknown'} files, ${info.totalChunks || 'unknown'} chunks)`);
            } else if (info.status === 'indexing') {
                if ('indexingPercentage' in info) {
                    validIndexingCodebases.set(codebasePath, info.indexingPercentage);
                }
                console.warn(`[SNAPSHOT-DEBUG] Found interrupted indexing codebase: ${codebasePath} (${info.indexingPercentage || 0}%). Treating as not indexed.`);
                // Don't add to indexed - treat interrupted indexing as not indexed
            } else if (info.status === 'indexfailed') {
                console.warn(`[SNAPSHOT-DEBUG] Found failed indexing codebase: ${codebasePath}. Error: ${info.errorMessage}`);
                // Failed indexing codebases are not added to indexed or indexing lists
                // But we keep the info for potential retry
            }
        }

        // Restore state
        this.indexedCodebases = validIndexedCodebases;
        this.indexingCodebases = new Map(); // Reset indexing codebases since they were interrupted
        this.codebaseFileCount = validFileCount;
        this.codebaseInfoMap = validCodebaseInfoMap;
    }

    public getIndexedCodebases(): string[] {
        // Read from JSON file to ensure consistency and persistence
        try {
            if (!fs.existsSync(this.snapshotFilePath)) {
                return [];
            }

            const snapshotData = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const snapshot: CodebaseSnapshot = JSON.parse(snapshotData);

            if (this.isV3Format(snapshot)) {
                // V3 format: collect all paths from indexed repositories
                const indexedPaths: string[] = [];
                for (const repo of Object.values(snapshot.repositories)) {
                    const defaultBranch = repo.branches[repo.defaultBranch || 'default'];
                    if (defaultBranch?.status === 'indexed') {
                        indexedPaths.push(...repo.knownPaths);
                    }
                }
                return indexedPaths;
            } else if (this.isV2Format(snapshot)) {
                return Object.entries(snapshot.codebases)
                    .filter(([_, info]) => info.status === 'indexed')
                    .map(([path, _]) => path);
            } else {
                // V1 format
                return (snapshot as CodebaseSnapshotV1).indexedCodebases || [];
            }
        } catch (error) {
            console.warn(`[SNAPSHOT-DEBUG] Error reading indexed codebases from file:`, error);
            // Fallback to memory if file reading fails
            return [...this.indexedCodebases];
        }
    }

    public getIndexingCodebases(): string[] {
        // Read from JSON file to ensure consistency and persistence
        try {
            if (!fs.existsSync(this.snapshotFilePath)) {
                return [];
            }

            const snapshotData = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const snapshot: CodebaseSnapshot = JSON.parse(snapshotData);

            if (this.isV3Format(snapshot)) {
                // V3 format: collect all paths from indexing repositories
                const indexingPaths: string[] = [];
                for (const repo of Object.values(snapshot.repositories)) {
                    const defaultBranch = repo.branches[repo.defaultBranch || 'default'];
                    if (defaultBranch?.status === 'indexing') {
                        indexingPaths.push(...repo.knownPaths);
                    }
                }
                return indexingPaths;
            } else if (this.isV2Format(snapshot)) {
                return Object.entries(snapshot.codebases)
                    .filter(([_, info]) => info.status === 'indexing')
                    .map(([path, _]) => path);
            } else {
                // V1 format - Handle both legacy array format and new object format
                const v1Snapshot = snapshot as CodebaseSnapshotV1;
                if (Array.isArray(v1Snapshot.indexingCodebases)) {
                    // Legacy format: return the array directly
                    return v1Snapshot.indexingCodebases;
                } else if (v1Snapshot.indexingCodebases && typeof v1Snapshot.indexingCodebases === 'object') {
                    // New format: return the keys of the object
                    return Object.keys(v1Snapshot.indexingCodebases);
                }
            }

            return [];
        } catch (error) {
            console.warn(`[SNAPSHOT-DEBUG] Error reading indexing codebases from file:`, error);
            // Fallback to memory if file reading fails
            return Array.from(this.indexingCodebases.keys());
        }
    }

    /**
     * @deprecated Use getCodebaseInfo() for individual codebases or iterate through codebases for v2 format support
     */
    public getIndexingCodebasesWithProgress(): Map<string, number> {
        return new Map(this.indexingCodebases);
    }

    public getIndexingProgress(codebasePath: string): number | undefined {
        // Read from JSON file to ensure consistency and persistence
        try {
            if (!fs.existsSync(this.snapshotFilePath)) {
                return undefined;
            }

            const snapshotData = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const snapshot: CodebaseSnapshot = JSON.parse(snapshotData);

            if (this.isV3Format(snapshot)) {
                // V3 format: find repo containing this path and get branch progress
                for (const repo of Object.values(snapshot.repositories)) {
                    if (repo.knownPaths.includes(codebasePath)) {
                        const defaultBranch = repo.branches[repo.defaultBranch || 'default'];
                        if (defaultBranch?.status === 'indexing') {
                            return defaultBranch.indexingPercentage || 0;
                        }
                        return undefined;
                    }
                }
                return undefined;
            } else if (this.isV2Format(snapshot)) {
                const info = snapshot.codebases[codebasePath];
                if (info && info.status === 'indexing') {
                    return info.indexingPercentage || 0;
                }
                return undefined;
            } else {
                // V1 format - Handle both legacy array format and new object format
                const v1Snapshot = snapshot as CodebaseSnapshotV1;
                if (Array.isArray(v1Snapshot.indexingCodebases)) {
                    // Legacy format: if path exists in array, assume 0% progress
                    return v1Snapshot.indexingCodebases.includes(codebasePath) ? 0 : undefined;
                } else if (v1Snapshot.indexingCodebases && typeof v1Snapshot.indexingCodebases === 'object') {
                    // New format: return the actual progress percentage
                    return v1Snapshot.indexingCodebases[codebasePath];
                }
            }

            return undefined;
        } catch (error) {
            console.warn(`[SNAPSHOT-DEBUG] Error reading progress from file for ${codebasePath}:`, error);
            // Fallback to memory if file reading fails
            return this.indexingCodebases.get(codebasePath);
        }
    }

    /**
     * @deprecated Use setCodebaseIndexing() instead for v2 format support
     */
    public addIndexingCodebase(codebasePath: string, progress: number = 0): void {
        this.indexingCodebases.set(codebasePath, progress);

        // Also update codebaseInfoMap for v2 compatibility
        const info: CodebaseInfoIndexing = {
            status: 'indexing',
            indexingPercentage: progress,
            lastUpdated: new Date().toISOString()
        };
        this.codebaseInfoMap.set(codebasePath, info);
    }

    /**
     * @deprecated Use setCodebaseIndexing() instead for v2 format support
     */
    public updateIndexingProgress(codebasePath: string, progress: number): void {
        if (this.indexingCodebases.has(codebasePath)) {
            this.indexingCodebases.set(codebasePath, progress);

            // Also update codebaseInfoMap for v2 compatibility
            const info: CodebaseInfoIndexing = {
                status: 'indexing',
                indexingPercentage: progress,
                lastUpdated: new Date().toISOString()
            };
            this.codebaseInfoMap.set(codebasePath, info);
        }
    }

    /**
     * @deprecated Use removeCodebaseCompletely() or state-specific methods instead for v2 format support
     */
    public removeIndexingCodebase(codebasePath: string): void {
        this.indexingCodebases.delete(codebasePath);
        // Also remove from codebaseInfoMap for v2 compatibility
        this.codebaseInfoMap.delete(codebasePath);
    }

    /**
     * @deprecated Use setCodebaseIndexed() instead for v2 format support
     */
    public addIndexedCodebase(codebasePath: string, fileCount?: number): void {
        if (!this.indexedCodebases.includes(codebasePath)) {
            this.indexedCodebases.push(codebasePath);
        }
        if (fileCount !== undefined) {
            this.codebaseFileCount.set(codebasePath, fileCount);
        }

        // Also update codebaseInfoMap for v2 compatibility
        const info: CodebaseInfoIndexed = {
            status: 'indexed',
            indexedFiles: fileCount || 0,
            totalChunks: 0, // Unknown in v1 method
            indexStatus: 'completed',
            lastUpdated: new Date().toISOString()
        };
        this.codebaseInfoMap.set(codebasePath, info);
    }

    /**
     * @deprecated Use removeCodebaseCompletely() or state-specific methods instead for v2 format support
     */
    public removeIndexedCodebase(codebasePath: string): void {
        this.indexedCodebases = this.indexedCodebases.filter(path => path !== codebasePath);
        this.codebaseFileCount.delete(codebasePath);
        // Also remove from codebaseInfoMap for v2 compatibility
        this.codebaseInfoMap.delete(codebasePath);
    }

    /**
     * @deprecated Use setCodebaseIndexed() instead for v2 format support
     */
    public moveFromIndexingToIndexed(codebasePath: string, fileCount?: number): void {
        this.removeIndexingCodebase(codebasePath);
        this.addIndexedCodebase(codebasePath, fileCount);
    }

    /**
     * @deprecated Use getCodebaseInfo() and check indexedFiles property instead for v2 format support
     */
    public getIndexedFileCount(codebasePath: string): number | undefined {
        return this.codebaseFileCount.get(codebasePath);
    }

    /**
     * @deprecated Use setCodebaseIndexed() with complete stats instead for v2 format support
     */
    public setIndexedFileCount(codebasePath: string, fileCount: number): void {
        this.codebaseFileCount.set(codebasePath, fileCount);
    }

    /**
     * Set codebase to indexing status
     */
    public setCodebaseIndexing(codebasePath: string, progress: number = 0): void {
        this.indexingCodebases.set(codebasePath, progress);

        // Remove from other states
        this.indexedCodebases = this.indexedCodebases.filter(path => path !== codebasePath);
        this.codebaseFileCount.delete(codebasePath);

        // Update info map
        const info: CodebaseInfoIndexing = {
            status: 'indexing',
            indexingPercentage: progress,
            lastUpdated: new Date().toISOString()
        };
        this.codebaseInfoMap.set(codebasePath, info);
    }

    /**
     * Set codebase to indexed status with complete statistics
     */
    public setCodebaseIndexed(
        codebasePath: string,
        stats: { indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }
    ): void {
        // Add to indexed list if not already there
        if (!this.indexedCodebases.includes(codebasePath)) {
            this.indexedCodebases.push(codebasePath);
        }

        // Remove from indexing state
        this.indexingCodebases.delete(codebasePath);

        // Update file count and info
        this.codebaseFileCount.set(codebasePath, stats.indexedFiles);

        const info: CodebaseInfoIndexed = {
            status: 'indexed',
            indexedFiles: stats.indexedFiles,
            totalChunks: stats.totalChunks,
            indexStatus: stats.status,
            lastUpdated: new Date().toISOString()
        };
        this.codebaseInfoMap.set(codebasePath, info);
    }

    /**
     * Set codebase to failed status
     */
    public setCodebaseIndexFailed(
        codebasePath: string,
        errorMessage: string,
        lastAttemptedPercentage?: number
    ): void {
        // Remove from other states
        this.indexedCodebases = this.indexedCodebases.filter(path => path !== codebasePath);
        this.indexingCodebases.delete(codebasePath);
        this.codebaseFileCount.delete(codebasePath);

        // Update info map
        const info: CodebaseInfoIndexFailed = {
            status: 'indexfailed',
            errorMessage: errorMessage,
            lastAttemptedPercentage: lastAttemptedPercentage,
            lastUpdated: new Date().toISOString()
        };
        this.codebaseInfoMap.set(codebasePath, info);
    }

    /**
     * Get codebase status
     */
    public getCodebaseStatus(codebasePath: string): 'indexed' | 'indexing' | 'indexfailed' | 'not_found' {
        const info = this.codebaseInfoMap.get(codebasePath);
        if (!info) return 'not_found';
        return info.status;
    }

    /**
     * Get complete codebase information
     */
    public getCodebaseInfo(codebasePath: string): CodebaseInfo | undefined {
        return this.codebaseInfoMap.get(codebasePath);
    }

    /**
     * Get all failed codebases
     */
    public getFailedCodebases(): string[] {
        return Array.from(this.codebaseInfoMap.entries())
            .filter(([_, info]) => info.status === 'indexfailed')
            .map(([path, _]) => path);
    }

    /**
     * Completely remove a codebase from all tracking (for clear_index operation)
     */
    public removeCodebaseCompletely(codebasePath: string): void {
        // Remove from all internal state
        this.indexedCodebases = this.indexedCodebases.filter(path => path !== codebasePath);
        this.indexingCodebases.delete(codebasePath);
        this.codebaseFileCount.delete(codebasePath);
        this.codebaseInfoMap.delete(codebasePath);

        console.log(`[SNAPSHOT-DEBUG] Completely removed codebase from snapshot: ${codebasePath}`);
    }

    public loadCodebaseSnapshot(): void {
        console.log('[SNAPSHOT-DEBUG] Loading codebase snapshot from:', this.snapshotFilePath);

        try {
            if (!fs.existsSync(this.snapshotFilePath)) {
                console.log('[SNAPSHOT-DEBUG] Snapshot file does not exist. Starting with empty codebase list.');
                return;
            }

            const snapshotData = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const snapshot: CodebaseSnapshot = JSON.parse(snapshotData);

            console.log('[SNAPSHOT-DEBUG] Loaded snapshot format:',
                this.isV3Format(snapshot) ? 'v3' :
                this.isV2Format(snapshot) ? 'v2' : 'v1');

            if (this.isV3Format(snapshot)) {
                this.loadV3Format(snapshot);
            } else if (this.isV2Format(snapshot)) {
                this.migrateV2ToV3(snapshot);
            } else {
                this.migrateV1ToV3(snapshot);
            }

            // Always save in v3 format after loading (migration)
            this.saveCodebaseSnapshot();

        } catch (error: any) {
            console.error('[SNAPSHOT-DEBUG] Error loading snapshot:', error);
            console.log('[SNAPSHOT-DEBUG] Starting with empty codebase list due to snapshot error.');
        }
    }

    public saveCodebaseSnapshot(): void {
        console.log('[SNAPSHOT-DEBUG] Saving codebase snapshot to:', this.snapshotFilePath);

        try {
            // Ensure directory exists
            const snapshotDir = path.dirname(this.snapshotFilePath);
            if (!fs.existsSync(snapshotDir)) {
                fs.mkdirSync(snapshotDir, { recursive: true });
                console.log('[SNAPSHOT-DEBUG] Created snapshot directory:', snapshotDir);
            }

            // Build v3 format snapshot from repositories
            const repositories: Record<string, RepoSnapshot> = {};

            for (const [canonicalId, repoSnapshot] of this.repositories) {
                repositories[canonicalId] = repoSnapshot;
            }

            const snapshot: CodebaseSnapshotV3 = {
                formatVersion: 'v3',
                repositories,
                lastUpdated: new Date().toISOString()
            };

            fs.writeFileSync(this.snapshotFilePath, JSON.stringify(snapshot, null, 2));

            const repoCount = this.repositories.size;
            const indexedCount = this.indexedCodebases.length;
            const indexingCount = this.indexingCodebases.size;
            const failedCount = this.getFailedCodebases().length;

            console.log(`[SNAPSHOT-DEBUG] Snapshot saved successfully in v3 format. Repos: ${repoCount}, Indexed paths: ${indexedCount}, Indexing: ${indexingCount}, Failed: ${failedCount}`);

        } catch (error: any) {
            console.error('[SNAPSHOT-DEBUG] Error saving snapshot:', error);
        }
    }

    // ==================== V3 API Methods ====================

    /**
     * Get repository snapshot by canonical ID
     */
    public getRepository(canonicalId: string): RepoSnapshot | undefined {
        return this.repositories.get(canonicalId);
    }

    /**
     * Get repository by path (resolves canonical ID first)
     */
    public getRepositoryByPath(codebasePath: string): RepoSnapshot | undefined {
        const canonicalId = this.pathToCanonicalId.get(codebasePath);
        if (canonicalId) {
            return this.repositories.get(canonicalId);
        }
        return undefined;
    }

    /**
     * Get all repositories
     */
    public getAllRepositories(): Map<string, RepoSnapshot> {
        return new Map(this.repositories);
    }

    /**
     * Get canonical ID for a path
     */
    public getCanonicalIdForPath(codebasePath: string): string | undefined {
        return this.pathToCanonicalId.get(codebasePath);
    }

    /**
     * Update repository state when indexing starts/completes
     */
    public updateRepositoryState(
        codebasePath: string,
        branchName: string = 'default',
        branchState: Partial<BranchSnapshot>
    ): void {
        const identity = this.safeResolveIdentity(codebasePath);
        const canonicalId = identity?.canonicalId || this.pathBasedCanonicalId(codebasePath);

        let repo = this.repositories.get(canonicalId);
        const now = new Date().toISOString();

        if (!repo) {
            // Create new repository record
            repo = {
                displayName: identity?.displayName || path.basename(codebasePath),
                remoteUrl: identity?.remoteUrl,
                identitySource: identity?.identitySource || 'path-hash',
                knownPaths: [codebasePath],
                worktrees: identity?.isWorktree ? [codebasePath] : [],
                branches: {},
                defaultBranch: branchName,
                lastIndexed: now,
            };
            this.repositories.set(canonicalId, repo);
            this.pathToCanonicalId.set(codebasePath, canonicalId);
        } else {
            // Update existing repository
            if (!repo.knownPaths.includes(codebasePath)) {
                repo.knownPaths.push(codebasePath);
                this.pathToCanonicalId.set(codebasePath, canonicalId);
            }
            if (identity?.isWorktree && !repo.worktrees.includes(codebasePath)) {
                repo.worktrees.push(codebasePath);
            }
        }

        // Update branch state
        const existingBranch = repo.branches[branchName] || {
            status: 'indexing',
            indexedFiles: 0,
            totalChunks: 0,
            lastIndexed: now,
        };

        repo.branches[branchName] = {
            ...existingBranch,
            ...branchState,
            lastIndexed: now,
        };

        repo.lastIndexed = now;

        // Update legacy state for backward compatibility
        this.populateLegacyStateFromRepo(canonicalId, repo);
    }
} 