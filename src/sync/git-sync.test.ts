import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import { GitSync } from "./git-sync";

class NodeVaultAdapter implements Pick<
  DataAdapter,
  "readBinary" | "write" | "writeBinary" | "remove" | "list" | "mkdir" | "stat"
> {
  constructor(private root: string) {}

  private full(rel: string): string {
    return path.join(this.root, rel);
  }

  async readBinary(filepath: string): Promise<ArrayBuffer> {
    const buf = fs.readFileSync(this.full(filepath));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  async write(filepath: string, data: string): Promise<void> {
    const full = this.full(filepath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  }

  async writeBinary(filepath: string, data: ArrayBuffer): Promise<void> {
    const full = this.full(filepath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from(data));
  }

  async remove(filepath: string): Promise<void> {
    fs.rmSync(this.full(filepath), { force: true });
  }

  async list(dirpath: string): Promise<{ files: string[]; folders: string[] }> {
    const full = this.full(dirpath);
    if (!fs.existsSync(full)) {
      return { files: [], folders: [] };
    }
    const entries = fs.readdirSync(full, { withFileTypes: true });
    const prefix = dirpath ? `${dirpath}/` : "";
    return {
      files: entries
        .filter((e) => e.isFile())
        .map((e) => `${prefix}${e.name}`),
      folders: entries
        .filter((e) => e.isDirectory())
        .map((e) => `${prefix}${e.name}`),
    };
  }

  async mkdir(dirpath: string): Promise<void> {
    fs.mkdirSync(this.full(dirpath), { recursive: true });
  }

  async stat(filepath: string) {
    const s = fs.statSync(this.full(filepath));
    return {
      type: s.isFile() ? ("file" as const) : ("folder" as const),
      size: s.size,
      mtime: s.mtimeMs,
      ctime: s.ctimeMs,
    };
  }
}

describe("GitSync", () => {
  let tmp: string;
  let vaultPath: string;
  let adapter: NodeVaultAdapter;
  let gitSync: GitSync;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-sync-"));
    vaultPath = tmp;
    adapter = new NodeVaultAdapter(vaultPath);
    gitSync = new GitSync(
      adapter as unknown as DataAdapter,
      vaultPath,
      "token",
      "user",
      "repo",
      () => false
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("serializes concurrent sync calls", async () => {
    const internal = gitSync as unknown as {
      stageAll: () => Promise<void>;
      safeFetch: () => Promise<string | null>;
      hasLocalBranch: () => Promise<boolean>;
    };

    let active = 0;
    let maxActive = 0;
    const origStage = internal.stageAll.bind(gitSync);
    internal.stageAll = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 40));
      active--;
      return origStage();
    };
    internal.safeFetch = async () => null;
    internal.hasLocalBranch = async () => false;

    await Promise.all([gitSync.sync(), gitSync.sync()]);
    expect(maxActive).toBe(1);
  });
});
