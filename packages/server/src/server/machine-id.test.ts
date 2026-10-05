import type * as FsPromises from "node:fs/promises";
import type * as Os from "node:os";
import { beforeEach, expect, test, vi } from "vitest";

const fileMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  readFile: fileMocks.readFile,
  writeFile: fileMocks.writeFile,
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: () => "/test-home",
  hostname: () => "test-host",
}));

beforeEach(() => {
  vi.resetModules();
  fileMocks.readFile.mockReset();
  fileMocks.writeFile.mockReset();
});
// Reload the module in each test to reset its intentionally process-wide machine-id promise.

test("retries an empty concurrently created fallback machine id", async () => {
  const fallbackPath = "/test-home/.paseo-machine-id";
  const { getMachineId } = await import("./machine-id.js");
  let fallbackReads = 0;
  fileMocks.readFile.mockImplementation(async (filePath: string) => {
    if (filePath === "/etc/machine-id") {
      throw Object.assign(new Error("missing machine-id"), { code: "ENOENT" });
    }
    expect(filePath).toBe(fallbackPath);
    fallbackReads += 1;
    return fallbackReads < 4 ? "" : "winner-machine-id\n";
  });
  fileMocks.writeFile.mockRejectedValue(
    Object.assign(new Error("fallback already exists"), { code: "EEXIST" }),
  );

  await expect(getMachineId()).resolves.toBe("winner-machine-id");
  expect(fileMocks.writeFile).toHaveBeenCalledWith(
    fallbackPath,
    expect.stringMatching(/^test-host:/),
    { flag: "wx", mode: 0o600 },
  );
  expect(fallbackReads).toBe(4);
});

test("reports a cause when the fallback machine id remains empty", async () => {
  const fallbackPath = "/test-home/.paseo-machine-id";
  const { getMachineId } = await import("./machine-id.js");
  fileMocks.readFile.mockImplementation(async (filePath: string) => {
    if (filePath === "/etc/machine-id") {
      throw Object.assign(new Error("missing machine-id"), { code: "ENOENT" });
    }
    expect(filePath).toBe(fallbackPath);
    return "";
  });
  fileMocks.writeFile.mockRejectedValue(
    Object.assign(new Error("fallback already exists"), { code: "EEXIST" }),
  );

  await expect(getMachineId()).rejects.toMatchObject({
    message: `Cannot read machine identity at ${fallbackPath}`,
    cause: expect.objectContaining({
      message: `Machine identity file is empty at ${fallbackPath}`,
    }),
  });
});
