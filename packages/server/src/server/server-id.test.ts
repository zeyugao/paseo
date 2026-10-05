import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getOrCreateServerId } from "./server-id.js";
import { PRIVATE_FILE_MODE } from "./private-files.js";

const MODE_MASK = 0o777;
const PERMISSIVE_FILE_MODE = 0o644;

function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-server-id-"));
}

function modeOf(filePath: string): number {
  return statSync(filePath).mode & MODE_MASK;
}

describe("getOrCreateServerId", () => {
  let home: string;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PASEO_SERVER_ID;
    home = tmpHome();
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(home, { recursive: true, force: true });
  });

  it("creates and persists a stable id per PASEO_HOME", () => {
    const first = getOrCreateServerId(home);
    const second = getOrCreateServerId(home);
    expect(first).toBe(second);
    expect(first.startsWith("srv_")).toBe(true);

    const idPath = path.join(home, "server-id");
    expect(existsSync(idPath)).toBe(true);
    expect(readFileSync(idPath, "utf8").trim()).toBe(first);
  });

  function collectChildOutput(child: ChildProcess): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`server-id child exited ${code}: ${stderr}`));
      });
    });
  }

  it("adopts one winner during concurrent first creation", async () => {
    const gatePath = path.join(home, "create-server-id");
    const readyPaths = Array.from({ length: 12 }, (_, index) =>
      path.join(home, `server-id-ready-${index}`),
    );
    const moduleUrl = new URL("./server-id.ts", import.meta.url).href;
    const children = readyPaths.map((readyPath) => {
      const source = `
        import { existsSync, writeFileSync } from "node:fs";
        import { setTimeout as delay } from "node:timers/promises";
        import { getOrCreateServerId } from ${JSON.stringify(moduleUrl)};
        writeFileSync(${JSON.stringify(readyPath)}, "");
        while (!existsSync(${JSON.stringify(gatePath)})) await delay(1);
        process.stdout.write(getOrCreateServerId(${JSON.stringify(home)}, { env: {} }));
      `;
      return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    });
    const results = children.map(collectChildOutput);

    try {
      await vi.waitFor(() => expect(readyPaths.every(existsSync)).toBe(true), { timeout: 10_000 });
      writeFileSync(gatePath, "go");
      const ids = await Promise.all(results);

      expect(new Set(ids).size).toBe(1);
      expect(readFileSync(path.join(home, "server-id"), "utf8").trim()).toBe(ids[0]);
    } finally {
      for (const child of children) child.kill();
    }
  }, 20_000);

  it("respects and persists PASEO_SERVER_ID override", () => {
    process.env.PASEO_SERVER_ID = "test-daemon-id";
    const id = getOrCreateServerId(home);
    expect(id).toBe("test-daemon-id");

    const idPath = path.join(home, "server-id");
    expect(existsSync(idPath)).toBe(true);
    expect(readFileSync(idPath, "utf8").trim()).toBe("test-daemon-id");
  });

  it.each(["../escape", "nested/id", "nested\\id", "has space"])(
    "rejects unsafe PASEO_SERVER_ID %s",
    (serverId) => {
      process.env.PASEO_SERVER_ID = serverId;
      expect(() => getOrCreateServerId(home)).toThrow(
        "Invalid PASEO_SERVER_ID: it must not contain path separators, '..', or whitespace",
      );
      expect(existsSync(path.join(home, "server-id"))).toBe(false);
    },
  );

  it.each(["../escape", "nested/id", "nested\\id", "has space"])(
    "rejects unsafe persisted server id %s",
    (serverId) => {
      const idPath = path.join(home, "server-id");
      writeFileSync(idPath, `${serverId}\n`);

      expect(() => getOrCreateServerId(home)).toThrow(
        "Invalid PASEO_SERVER_ID: it must not contain path separators, '..', or whitespace",
      );
      expect(readFileSync(idPath, "utf8").trim()).toBe(serverId);
    },
  );

  describe.skipIf(process.platform === "win32")("file permissions", () => {
    it("creates server-id with private permissions", () => {
      getOrCreateServerId(home);

      expect(modeOf(path.join(home, "server-id"))).toBe(PRIVATE_FILE_MODE);
    });

    it("repairs existing server-id permissions when loading", () => {
      const idPath = path.join(home, "server-id");
      writeFileSync(idPath, "srv_existing\n", { mode: PERMISSIVE_FILE_MODE });
      chmodSync(idPath, PERMISSIVE_FILE_MODE);

      expect(getOrCreateServerId(home)).toBe("srv_existing");
      expect(modeOf(idPath)).toBe(PRIVATE_FILE_MODE);
    });

    it("repairs existing server-id permissions when using an env override", () => {
      const idPath = path.join(home, "server-id");
      process.env.PASEO_SERVER_ID = "test-daemon-id";
      writeFileSync(idPath, "srv_existing\n", { mode: PERMISSIVE_FILE_MODE });
      chmodSync(idPath, PERMISSIVE_FILE_MODE);

      expect(getOrCreateServerId(home)).toBe("test-daemon-id");
      expect(modeOf(idPath)).toBe(PRIVATE_FILE_MODE);
    });
  });
});
