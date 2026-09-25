import * as git from "isomorphic-git";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const AUTHOR = { name: "Test", email: "test@test.local" };

describe("merge and checkout", () => {
  let tmp: string;
  let dir: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-sync-"));
    dir = path.join(tmp, "vault");
    fs.mkdirSync(dir);
    await git.init({ fs, dir, defaultBranch: "main" });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes merged remote content to disk after checkout", async () => {
    fs.writeFileSync(path.join(dir, "note.md"), "v1\n");
    await git.add({ fs, dir, filepath: "note.md" });
    await git.commit({ fs, dir, message: "v1", author: AUTHOR });

    await git.branch({ fs, dir, ref: "side" });
    await git.checkout({ fs, dir, ref: "side" });
    fs.writeFileSync(path.join(dir, "note.md"), "v2\n");
    await git.add({ fs, dir, filepath: "note.md" });
    await git.commit({ fs, dir, message: "v2", author: AUTHOR });
    const sideOid = await git.resolveRef({ fs, dir, ref: "side" });

    await git.checkout({ fs, dir, ref: "main" });

    await git.merge({
      fs,
      dir,
      ours: "main",
      theirs: sideOid,
      author: AUTHOR,
      message: "merge",
      fastForwardOnly: false,
      abortOnConflict: true,
    });

    await git.checkout({ fs, dir, ref: "main" });

    const onDisk = fs.readFileSync(path.join(dir, "note.md"), "utf8");
    expect(onDisk).toBe("v2\n");
  });

  it("creates a two-parent merge commit after manual resolution", async () => {
    fs.writeFileSync(path.join(dir, "note.md"), "base\n");
    await git.add({ fs, dir, filepath: "note.md" });
    await git.commit({ fs, dir, message: "base", author: AUTHOR });

    await git.branch({ fs, dir, ref: "side" });
    await git.checkout({ fs, dir, ref: "side" });
    fs.writeFileSync(path.join(dir, "note.md"), "theirs\n");
    await git.add({ fs, dir, filepath: "note.md" });
    await git.commit({ fs, dir, message: "theirs", author: AUTHOR });
    const theirsOid = await git.resolveRef({ fs, dir, ref: "side" });

    await git.checkout({ fs, dir, ref: "main" });
    fs.writeFileSync(path.join(dir, "note.md"), "ours\n");
    await git.add({ fs, dir, filepath: "note.md" });
    const oursOid = await git.commit({
      fs,
      dir,
      message: "ours",
      author: AUTHOR,
    });

    try {
      await git.merge({
        fs,
        dir,
        ours: "main",
        theirs: theirsOid,
        author: AUTHOR,
        message: "merge",
        fastForwardOnly: false,
        abortOnConflict: false,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(git.Errors.MergeConflictError);
    }

    fs.writeFileSync(path.join(dir, "note.md"), "resolved\n");
    await git.add({ fs, dir, filepath: "note.md" });
    const mergeOid = await git.commit({
      fs,
      dir,
      ref: "main",
      message: "resolve",
      author: AUTHOR,
      parent: [oursOid, theirsOid],
    });

    const { commit } = await git.readCommit({ fs, dir, oid: mergeOid });
    expect(commit.parent).toHaveLength(2);
  });

  it("stages deletes from statusMatrix", async () => {
    fs.writeFileSync(path.join(dir, "drop.md"), "x");
    await git.add({ fs, dir, filepath: "drop.md" });
    await git.commit({ fs, dir, message: "add", author: AUTHOR });

    fs.unlinkSync(path.join(dir, "drop.md"));

    const matrix = await git.statusMatrix({ fs, dir });
    const row = matrix.find(([p]) => p === "drop.md");
    expect(row?.[2]).toBe(0);

    await git.remove({ fs, dir, filepath: "drop.md" });
    await git.commit({ fs, dir, message: "delete", author: AUTHOR });

    const log = await git.log({ fs, dir, ref: "main" });
    expect(log[0]?.commit.message.trim()).toBe("delete");
  });
});
