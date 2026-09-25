import * as git from "isomorphic-git";
import { requestUrl, DataAdapter } from "obsidian";
import { createFsAdapter } from "./fs-adapter";
import {
  GIT_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL,
  DEFAULT_BRANCH,
} from "../constants";
import { ConflictFile, PendingMerge, SyncResult } from "../types";

// Custom HTTP client that uses Obsidian's requestUrl (mobile-safe, bypasses CORS)
const gitHttp = {
  async request({ url, method, headers, body }: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: AsyncIterableIterator<Uint8Array>;
  }) {
    let bodyBuffer: ArrayBuffer | undefined;
    if (body) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
      bodyBuffer = merged.buffer;
    }

    const response = await requestUrl({
      url,
      method,
      headers,
      body: bodyBuffer,
      throw: false,
    });

    const arrayBuffer = response.arrayBuffer;
    async function* responseBody() {
      yield new Uint8Array(arrayBuffer);
    }

    return {
      url,
      method,
      statusCode: response.status,
      statusMessage: "OK",
      body: responseBody(),
      headers: response.headers as Record<string, string>,
    };
  },
};

export type IsExcludedFn = (filepath: string) => boolean;

type MergeRemoteResult =
  | { type: "ok" }
  | { type: "conflict"; conflicts: ConflictFile[]; theirs: string };

export class GitSync {
  private fs: ReturnType<typeof createFsAdapter>;
  private dir: string;
  private token: string;
  private username: string;
  private remoteUrl: string;
  private isExcluded: IsExcludedFn;
  private lock: Promise<void> = Promise.resolve();
  private applyingRemote = false;

  constructor(
    adapter: DataAdapter,
    vaultPath: string,
    token: string,
    username: string,
    repoName: string,
    isExcluded: IsExcludedFn = () => false
  ) {
    this.fs = createFsAdapter(adapter, vaultPath);
    this.dir = vaultPath;
    this.token = token;
    this.username = username;
    this.remoteUrl = `https://github.com/${username}/${repoName}.git`;
    this.isExcluded = isExcluded;
  }

  /** True while checkout is writing merged remote files to the vault. */
  get isApplyingRemote(): boolean {
    return this.applyingRemote;
  }

  setIsExcluded(fn: IsExcludedFn): void {
    this.isExcluded = fn;
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Base options shared by ALL git operations (local and network) */
  private gitOpts() {
    return {
      fs: this.fs,
      http: gitHttp,
      dir: this.dir,
      author: { name: GIT_AUTHOR_NAME, email: GIT_AUTHOR_EMAIL },
    };
  }

  /**
   * Extra options for NETWORK operations (push / fetch / clone).
   */
  private netOpts() {
    const token = this.token;
    const username = this.username;
    return {
      ...this.gitOpts(),
      url: this.remoteUrl,
      onAuth: () => ({ username, password: token }),
      onAuthFailure: () => {
        throw new Error("GitHub authentication failed. Please reconnect your account in Git Sync settings.");
      },
    };
  }

  /** Returns true if .git exists and HEAD resolves (repo is initialised) */
  async isInitialized(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "HEAD" });
      return true;
    } catch {
      return false;
    }
  }

  /** Returns true if refs/heads/main exists (at least one commit has been made). */
  async hasLocalBranch(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.fs, dir: this.dir, ref: DEFAULT_BRANCH });
      return true;
    } catch {
      return false;
    }
  }

  private shouldTrack(filepath: string): boolean {
    if (filepath.startsWith(".git/") || filepath === ".git") return false;
    return !this.isExcluded(filepath);
  }

  /** Stage adds and deletes from statusMatrix (respects exclusion filter). */
  private async stageAll(): Promise<void> {
    const matrix = await git.statusMatrix({
      fs: this.fs,
      dir: this.dir,
      filter: (f) => this.shouldTrack(f),
    });

    for (const [filepath, , workdir] of matrix) {
      if (!this.shouldTrack(filepath)) continue;
      try {
        if (workdir === 0) {
          await git.remove({ fs: this.fs, dir: this.dir, filepath });
        } else {
          await git.add({ fs: this.fs, dir: this.dir, filepath });
        }
      } catch {
        // Skip un-stageable paths
      }
    }
  }

  private async commitIfDirty(message: string): Promise<void> {
    let hasDirty: boolean;
    try {
      const matrix = await git.statusMatrix({ fs: this.fs, dir: this.dir });
      hasDirty = matrix.some(([, h, w, s]) => h !== 1 || w !== 1 || s !== 1);
    } catch {
      hasDirty = false;
    }

    if (hasDirty) {
      await git.commit({
        ...this.gitOpts(),
        message,
      });
    }
  }

  /**
   * Fetch from origin. Returns the FETCH_HEAD oid when remote has commits,
   * or null when the remote is empty or unreachable.
   */
  private async safeFetch(): Promise<string | null> {
    try {
      await git.fetch({
        ...this.netOpts(),
        ref: DEFAULT_BRANCH,
        singleBranch: true,
      });
      return await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "FETCH_HEAD" });
    } catch {
      return null;
    }
  }

  private async checkoutMain(): Promise<void> {
    this.applyingRemote = true;
    try {
      await git.checkout({
        fs: this.fs,
        dir: this.dir,
        ref: DEFAULT_BRANCH,
      });
    } finally {
      this.applyingRemote = false;
    }
  }

  private async readBlobAtCommit(
    commitOid: string,
    filepath: string
  ): Promise<string> {
    try {
      const { blob } = await git.readBlob({
        fs: this.fs,
        dir: this.dir,
        oid: commitOid,
        filepath,
      });
      return new TextDecoder().decode(blob);
    } catch {
      return "";
    }
  }

  private async buildConflicts(
    filepaths: string[],
    oursOid: string,
    theirsOid: string
  ): Promise<ConflictFile[]> {
    const conflicts: ConflictFile[] = [];
    for (const path of filepaths) {
      if (!this.shouldTrack(path)) continue;
      conflicts.push({
        path,
        ours: await this.readBlobAtCommit(oursOid, path),
        theirs: await this.readBlobAtCommit(theirsOid, path),
      });
    }
    return conflicts;
  }

  /** Rebuild conflict file contents from a persisted pending merge. */
  async loadConflictFiles(pending: PendingMerge): Promise<ConflictFile[]> {
    const localHead = await git.resolveRef({
      fs: this.fs,
      dir: this.dir,
      ref: DEFAULT_BRANCH,
    });
    return this.buildConflicts(
      pending.conflictPaths,
      localHead,
      pending.theirs
    );
  }

  /**
   * Merge FETCH_HEAD into main; checkout on success.
   */
  private async mergeRemote(fetchHead: string): Promise<MergeRemoteResult> {
    const localHead = await git.resolveRef({
      fs: this.fs,
      dir: this.dir,
      ref: DEFAULT_BRANCH,
    });

    if (fetchHead === localHead) {
      return { type: "ok" };
    }

    try {
      await git.merge({
        fs: this.fs,
        dir: this.dir,
        ours: DEFAULT_BRANCH,
        theirs: fetchHead,
        author: { name: GIT_AUTHOR_NAME, email: GIT_AUTHOR_EMAIL },
        message: "sync: merge remote changes",
        fastForwardOnly: false,
        abortOnConflict: true,
      });
    } catch (error: unknown) {
      if (error instanceof git.Errors.MergeConflictError) {
        const conflicts = await this.buildConflicts(
          error.data.filepaths,
          localHead,
          fetchHead
        );
        return { type: "conflict", conflicts, theirs: fetchHead };
      }
      if (error instanceof git.Errors.MergeNotSupportedError) {
        throw error;
      }
      throw error;
    }

    await this.checkoutMain();
    return { type: "ok" };
  }

  /**
   * Clone the remote into the vault directory.
   * Returns true if the clone produced a usable local branch (non-empty remote).
   */
  async clone(): Promise<boolean> {
    return this.runExclusive(async () => {
      await git.clone({
        ...this.netOpts(),
        singleBranch: true,
      });
      return this.hasLocalBranch();
    });
  }

  /**
   * First-time setup: init locally (if needed), commit everything, push.
   */
  async initAndPush(): Promise<void> {
    return this.runExclusive(async () => {
      const alreadyInited = await this.isInitialized();
      if (!alreadyInited) {
        await git.init({ fs: this.fs, dir: this.dir, defaultBranch: DEFAULT_BRANCH });
      }

      await this.stageAll();

      const localBranchExists = await this.hasLocalBranch();
      if (!localBranchExists) {
        await git.commit({
          ...this.gitOpts(),
          message: "sync: initial vault snapshot",
        });
      } else {
        await this.commitIfDirty("sync: initial vault snapshot");
      }

      try {
        await git.deleteRemote({ fs: this.fs, dir: this.dir, remote: "origin" });
      } catch { /* didn't exist yet */ }
      await git.addRemote({
        fs: this.fs,
        dir: this.dir,
        remote: "origin",
        url: this.remoteUrl,
      });

      await git.push({
        ...this.netOpts(),
        ref: DEFAULT_BRANCH,
        force: false,
      });
    });
  }

  /**
   * Full sync cycle — stage, commit, fetch, merge, checkout, push.
   */
  async sync(): Promise<SyncResult> {
    return this.runExclusive(async () => {
      try {
        await this.stageAll();
        const now = new Date().toISOString().replace("T", " ").slice(0, 19);
        await this.commitIfDirty(`sync: ${now}`);

        const fetchHead = await this.safeFetch();

        if (fetchHead && (await this.hasLocalBranch())) {
          const mergeResult = await this.mergeRemote(fetchHead);
          if (mergeResult.type === "conflict") {
            const pendingMerge: PendingMerge = {
              theirs: mergeResult.theirs,
              conflictPaths: mergeResult.conflicts.map((c) => c.path),
            };
            return {
              success: false,
              conflictFiles: mergeResult.conflicts,
              pendingMerge,
            };
          }
        }

        if (await this.hasLocalBranch()) {
          await git.push({
            ...this.netOpts(),
            ref: DEFAULT_BRANCH,
          });
        }

        return { success: true, conflictFiles: [], pendingMerge: null };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, conflictFiles: [], error: msg };
      }
    });
  }

  /**
   * Finish a pending merge after the user resolves all conflicts.
   */
  async completeMerge(
    resolutions: Map<string, string>,
    theirs: string
  ): Promise<SyncResult> {
    return this.runExclusive(async () => {
      try {
        const localHead = await git.resolveRef({
          fs: this.fs,
          dir: this.dir,
          ref: DEFAULT_BRANCH,
        });

        try {
          await git.merge({
            fs: this.fs,
            dir: this.dir,
            ours: DEFAULT_BRANCH,
            theirs,
            author: { name: GIT_AUTHOR_NAME, email: GIT_AUTHOR_EMAIL },
            message: "sync: merge remote changes",
            fastForwardOnly: false,
            abortOnConflict: false,
          });
        } catch (error: unknown) {
          if (!(error instanceof git.Errors.MergeConflictError)) {
            throw error;
          }
        }

        for (const [filepath, content] of resolutions) {
          const fullPath = this.dir
            ? `${this.dir}/${filepath}`
            : filepath;
          await this.fs.promises.writeFile(fullPath, content);
          await git.add({ fs: this.fs, dir: this.dir, filepath });
        }

        await git.commit({
          ...this.gitOpts(),
          ref: DEFAULT_BRANCH,
          message: "sync: resolve merge conflict",
          parent: [localHead, theirs],
        });

        await this.checkoutMain();

        await git.push({
          ...this.netOpts(),
          ref: DEFAULT_BRANCH,
        });

        return { success: true, conflictFiles: [], pendingMerge: null };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, conflictFiles: [], error: msg };
      }
    });
  }
}
