import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, test } from "vitest";

import { writeFileAtomic, writeJsonFileAtomic } from "./atomic-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("writeFileAtomic", () => {
  test("writes a JSON value to a new path", async () => {
    const root = await temporaryDirectory("paseo-atomic-file-");
    const filePath = path.join(root, "nested", "records.json");

    await writeJsonFileAtomic(filePath, { ready: true });

    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({ ready: true });
  });

  test("replaces a symlink when raw writes do not opt into preservation", async () => {
    const root = await temporaryDirectory("paseo-atomic-file-");
    const targetDirectory = await temporaryDirectory("paseo-atomic-target-");
    const targetPath = path.join(targetDirectory, "state.txt");
    const linkPath = path.join(root, "state.txt");
    await fs.writeFile(targetPath, "old");
    await fs.symlink(targetPath, linkPath);

    await writeFileAtomic(linkPath, "new");

    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(linkPath, "utf8")).toBe("new");
    expect(await fs.readFile(targetPath, "utf8")).toBe("old");
  });

  test.skipIf(process.platform === "win32")(
    "preserves a symlink when a raw write opts in",
    async () => {
      const root = await temporaryDirectory("paseo-atomic-file-");
      const targetDirectory = await temporaryDirectory("paseo-atomic-target-");
      const targetPath = path.join(targetDirectory, "state.txt");
      const linkPath = path.join(root, "state.txt");
      await fs.writeFile(targetPath, "old");
      await fs.symlink(targetPath, linkPath);

      await writeFileAtomic(linkPath, "new", { preserveSymlink: true });

      expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(targetPath, "utf8")).toBe("new");
    },
  );

  test.skipIf(process.platform === "win32")(
    "updates an absolute symlink target while preserving the link",
    async () => {
      const root = await temporaryDirectory("paseo-atomic-file-");
      const targetDirectory = await temporaryDirectory("paseo-atomic-target-");
      const targetPath = path.join(targetDirectory, "projects.json");
      const linkPath = path.join(root, "projects.json");
      await fs.writeFile(targetPath, "[]");
      await fs.symlink(targetPath, linkPath);

      await writeJsonFileAtomic(linkPath, [{ projectId: "prj_test" }]);

      expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await fs.readFile(targetPath, "utf8"))).toEqual([
        { projectId: "prj_test" },
      ]);
      expect(JSON.parse(await fs.readFile(linkPath, "utf8"))).toEqual([{ projectId: "prj_test" }]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "resolves relative symlinks in the link's directory",
    async () => {
      const root = await temporaryDirectory("paseo-atomic-file-");
      const linkDirectory = path.join(root, "links");
      const targetDirectory = path.join(root, "target");
      await fs.mkdir(linkDirectory);
      await fs.mkdir(targetDirectory);
      const targetPath = path.join(targetDirectory, "config.json");
      const linkPath = path.join(linkDirectory, "config.json");
      await fs.writeFile(targetPath, "{}\n");
      await fs.symlink(path.relative(linkDirectory, targetPath), linkPath);

      await writeJsonFileAtomic(linkPath, { enabled: true });

      expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await fs.readFile(targetPath, "utf8"))).toEqual({ enabled: true });
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects dangling symlinks without replacing them or leaving a temp file",
    async () => {
      const root = await temporaryDirectory("paseo-atomic-file-");
      const targetDirectory = await temporaryDirectory("paseo-atomic-target-");
      const targetPath = path.join(targetDirectory, "missing.json");
      const linkPath = path.join(root, "missing.json");
      await fs.symlink(targetPath, linkPath);

      await expect(writeJsonFileAtomic(linkPath, { enabled: true })).rejects.toMatchObject({
        code: "ENOENT",
      });

      expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await fs.readdir(targetDirectory)).toEqual([]);
    },
  );

  test("removes the temporary file when the final rename fails", async () => {
    const root = await temporaryDirectory("paseo-atomic-file-");
    const directoryPath = path.join(root, "state.json");
    await fs.mkdir(directoryPath);

    await expect(writeJsonFileAtomic(directoryPath, { enabled: true })).rejects.toThrow();

    expect(await fs.readdir(root)).toEqual(["state.json"]);
  });
});

describe("Windows replace retries", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])(
    "commits a completed receipt after transient Windows %s replace failures",
    async (code) => {
      const directory = await temporaryDirectory("paseo-atomic-file-");
      const file = path.join(directory, "receipt.json");
      await writeJsonFileAtomic(file, { state: "pending" });
      let failures = 3;
      let elapsed = 0;
      await writeJsonFileAtomic(
        file,
        { state: "completed" },
        {
          operations: {
            platform: "win32",
            now: () => elapsed,
            sleep: async (milliseconds) => {
              elapsed += milliseconds;
            },
            rename: async (source, destination) => {
              if (failures-- > 0) {
                expect(JSON.parse(await fs.readFile(destination, "utf8"))).toEqual({
                  state: "pending",
                });
                expect(JSON.parse(await fs.readFile(source, "utf8"))).toEqual({
                  state: "completed",
                });
                throw Object.assign(new Error("destination held open"), { code });
              }
              await fs.rename(source, destination);
            },
          },
        },
      );
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ state: "completed" });
      expect(await fs.readdir(directory)).toEqual(["receipt.json"]);
      expect(elapsed).toBeGreaterThan(0);
    },
  );

  it.each(["EPERM", "EACCES", "EBUSY"])(
    "preserves the previous file and removes the temp file when Windows %s persists",
    async (code) => {
      const directory = await temporaryDirectory("paseo-atomic-file-");
      const file = path.join(directory, "receipt.json");
      await writeJsonFileAtomic(file, { state: "pending" });
      const error = Object.assign(new Error("destination held open"), { code });
      const waits: number[] = [];
      let elapsed = 0;
      const attempts: number[] = [];
      await expect(
        writeJsonFileAtomic(
          file,
          { state: "completed" },
          {
            operations: {
              platform: "win32",
              now: () => elapsed,
              sleep: async (milliseconds) => {
                waits.push(milliseconds);
                elapsed += milliseconds;
              },
              rename: async () => {
                attempts.push(elapsed);
                throw error;
              },
            },
          },
        ),
      ).rejects.toBe(error);
      expect(elapsed).toBe(1000);
      expect(waits.slice(0, 5)).toEqual([10, 20, 40, 80, 100]);
      expect(Math.max(...waits)).toBe(100);
      expect(attempts.every((time) => time < 1000)).toBe(true);
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ state: "pending" });
      expect(await fs.readdir(directory)).toEqual(["receipt.json"]);
    },
  );

  it.each([
    ["linux", "EPERM"],
    ["darwin", "EACCES"],
    ["linux", "EBUSY"],
    ["win32", "ENOENT"],
    ["win32", "ENOSPC"],
    ["win32", "EXDEV"],
  ] as const)("does not retry %s %s failures", async (platform, code) => {
    const directory = await temporaryDirectory("paseo-atomic-file-");
    const file = path.join(directory, "receipt.json");
    await writeJsonFileAtomic(file, { state: "pending" });
    const error = Object.assign(new Error("rename failed"), { code });
    let attempts = 0;
    const waits: number[] = [];
    await expect(
      writeFileAtomic(file, "replacement", {
        operations: {
          platform,
          now: () => 0,
          sleep: async (milliseconds) => {
            waits.push(milliseconds);
          },
          rename: async () => {
            attempts++;
            throw error;
          },
        },
      }),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
    expect(waits).toEqual([]);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ state: "pending" });
    expect(await fs.readdir(directory)).toEqual(["receipt.json"]);
  });

  it("does not retry after a rename consumes the Windows retry budget", async () => {
    const directory = await temporaryDirectory("paseo-atomic-file-");
    const error = Object.assign(new Error("slow rename failed"), { code: "EPERM" });
    let elapsed = 0;
    const waits: number[] = [];
    await expect(
      writeFileAtomic(path.join(directory, "file"), "replacement", {
        operations: {
          platform: "win32",
          now: () => elapsed,
          sleep: async (milliseconds) => {
            waits.push(milliseconds);
          },
          rename: async () => {
            elapsed += 1000;
            throw error;
          },
        },
      }),
    ).rejects.toBe(error);
    expect(waits).toEqual([]);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("creates parent directories and replaces binary and JSON files through the default runtime", async () => {
    const directory = await temporaryDirectory("paseo-atomic-file-");
    const file = path.join(directory, "nested", "file");
    const bytes = Buffer.from([0, 255, 128, 1]);
    await writeFileAtomic(file, bytes);
    expect(await fs.readFile(file)).toEqual(bytes);
    await writeJsonFileAtomic(file, { state: "completed" });
    expect(await fs.readFile(file, "utf8")).toBe('{\n  "state": "completed"\n}');
    expect(await fs.readdir(path.dirname(file))).toEqual(["file"]);
  });
});
