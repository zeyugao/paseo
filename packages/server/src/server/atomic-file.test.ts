import { lstat, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { writeFileAtomic, writeJsonFileAtomic } from "./atomic-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("writeFileAtomic", () => {
  test("writes a JSON value to a new path", async () => {
    const root = await temporaryDirectory("paseo-atomic-file-");
    const filePath = path.join(root, "nested", "records.json");

    await writeJsonFileAtomic(filePath, { ready: true });

    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ ready: true });
  });

  test("replaces a symlink when raw writes do not opt into preservation", async () => {
    const root = await temporaryDirectory("paseo-atomic-file-");
    const targetDirectory = await temporaryDirectory("paseo-atomic-target-");
    const targetPath = path.join(targetDirectory, "state.txt");
    const linkPath = path.join(root, "state.txt");
    await writeFile(targetPath, "old");
    await symlink(targetPath, linkPath);

    await writeFileAtomic(linkPath, "new");

    expect((await lstat(linkPath)).isSymbolicLink()).toBe(false);
    expect(await readFile(linkPath, "utf8")).toBe("new");
    expect(await readFile(targetPath, "utf8")).toBe("old");
  });

  test.skipIf(process.platform === "win32")(
    "preserves a symlink when a raw write opts in",
    async () => {
      const root = await temporaryDirectory("paseo-atomic-file-");
      const targetDirectory = await temporaryDirectory("paseo-atomic-target-");
      const targetPath = path.join(targetDirectory, "state.txt");
      const linkPath = path.join(root, "state.txt");
      await writeFile(targetPath, "old");
      await symlink(targetPath, linkPath);

      await writeFileAtomic(linkPath, "new", { preserveSymlink: true });

      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(targetPath, "utf8")).toBe("new");
    },
  );

  test.skipIf(process.platform === "win32")(
    "updates an absolute symlink target while preserving the link",
    async () => {
      const root = await temporaryDirectory("paseo-atomic-file-");
      const targetDirectory = await temporaryDirectory("paseo-atomic-target-");
      const targetPath = path.join(targetDirectory, "projects.json");
      const linkPath = path.join(root, "projects.json");
      await writeFile(targetPath, "[]");
      await symlink(targetPath, linkPath);

      await writeJsonFileAtomic(linkPath, [{ projectId: "prj_test" }]);

      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await readFile(targetPath, "utf8"))).toEqual([{ projectId: "prj_test" }]);
      expect(JSON.parse(await readFile(linkPath, "utf8"))).toEqual([{ projectId: "prj_test" }]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "resolves relative symlinks in the link's directory",
    async () => {
      const root = await temporaryDirectory("paseo-atomic-file-");
      const linkDirectory = path.join(root, "links");
      const targetDirectory = path.join(root, "target");
      await mkdir(linkDirectory);
      await mkdir(targetDirectory);
      const targetPath = path.join(targetDirectory, "config.json");
      const linkPath = path.join(linkDirectory, "config.json");
      await writeFile(targetPath, "{}\n");
      await symlink(path.relative(linkDirectory, targetPath), linkPath);

      await writeJsonFileAtomic(linkPath, { enabled: true });

      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await readFile(targetPath, "utf8"))).toEqual({ enabled: true });
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects dangling symlinks without replacing them or leaving a temp file",
    async () => {
      const root = await temporaryDirectory("paseo-atomic-file-");
      const targetDirectory = await temporaryDirectory("paseo-atomic-target-");
      const targetPath = path.join(targetDirectory, "missing.json");
      const linkPath = path.join(root, "missing.json");
      await symlink(targetPath, linkPath);

      await expect(writeJsonFileAtomic(linkPath, { enabled: true })).rejects.toMatchObject({
        code: "ENOENT",
      });

      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await readdir(targetDirectory)).toEqual([]);
    },
  );

  test("removes the temporary file when the final rename fails", async () => {
    const root = await temporaryDirectory("paseo-atomic-file-");
    const directoryPath = path.join(root, "state.json");
    await mkdir(directoryPath);

    await expect(writeJsonFileAtomic(directoryPath, { enabled: true })).rejects.toThrow();

    expect(await readdir(root)).toEqual(["state.json"]);
  });
});
