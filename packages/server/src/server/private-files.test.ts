import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { PRIVATE_FILE_MODE, writePrivateFileAtomicSync } from "./private-files.js";

const temporaryDirectories: string[] = [];
const MODE_MASK = 0o777;
const SHARED_DIRECTORY_MODE = 0o755;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function modeOf(filePath: string): number {
  return statSync(filePath).mode & MODE_MASK;
}

describe("writePrivateFileAtomicSync", () => {
  test("creates a private file and parent directory", () => {
    const root = temporaryDirectory("paseo-private-file-");
    const filePath = path.join(root, "nested", "state.json");

    writePrivateFileAtomicSync(filePath, "{}\n");

    expect(readFileSync(filePath, "utf8")).toBe("{}\n");
    expect(modeOf(filePath)).toBe(PRIVATE_FILE_MODE);
  });

  test.skipIf(process.platform === "win32")(
    "updates a symlink target without replacing the link or changing its parent mode",
    () => {
      const root = temporaryDirectory("paseo-private-file-");
      const targetRoot = temporaryDirectory("paseo-private-target-");
      const targetPath = path.join(targetRoot, "config.json");
      const linkPath = path.join(root, "config.json");
      chmodSync(targetRoot, SHARED_DIRECTORY_MODE);
      writeFileSync(targetPath, "old\n");
      symlinkSync(targetPath, linkPath);

      writePrivateFileAtomicSync(linkPath, "new\n", { preserveSymlink: true });

      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(targetPath, "utf8")).toBe("new\n");
      expect(modeOf(targetPath)).toBe(PRIVATE_FILE_MODE);
      expect(modeOf(targetRoot)).toBe(SHARED_DIRECTORY_MODE);
      expect(readdirSync(targetRoot)).toEqual(["config.json"]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects a dangling symlink before creating a replacement",
    () => {
      const root = temporaryDirectory("paseo-private-file-");
      const targetRoot = temporaryDirectory("paseo-private-target-");
      const targetPath = path.join(targetRoot, "missing.json");
      const linkPath = path.join(root, "missing.json");
      symlinkSync(targetPath, linkPath);

      expect(() =>
        writePrivateFileAtomicSync(linkPath, "new\n", { preserveSymlink: true }),
      ).toThrow(/ENOENT|no such file/i);

      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(readdirSync(targetRoot)).toEqual([]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "keeps the legacy replacement behavior when preservation is disabled",
    () => {
      const root = temporaryDirectory("paseo-private-file-");
      const targetRoot = temporaryDirectory("paseo-private-target-");
      const targetPath = path.join(targetRoot, "state.txt");
      const linkPath = path.join(root, "state.txt");
      writeFileSync(targetPath, "old\n");
      symlinkSync(targetPath, linkPath);

      writePrivateFileAtomicSync(linkPath, "new\n");

      expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
      expect(readFileSync(linkPath, "utf8")).toBe("new\n");
      expect(readFileSync(targetPath, "utf8")).toBe("old\n");
    },
  );
});
