import type * as FsPromises from "node:fs/promises";
import type * as Os from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fileMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: fileMocks.execFile,
  }),
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

const originalPlatform = process.platform;

beforeEach(() => {
  vi.resetModules();
  fileMocks.readFile.mockReset();
  fileMocks.writeFile.mockReset();
  fileMocks.execFile.mockReset();
  fileMocks.execFile.mockRejectedValue(new Error("Hardware identity unavailable"));
  Object.defineProperty(process, "platform", { value: "darwin" });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
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

test("reads the macOS hardware identity when no persisted identity exists", async () => {
  fileMocks.readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  fileMocks.execFile.mockImplementation(async (command: string, args: string[]) => {
    if (command !== "ioreg" || !args.includes("IOPlatformExpertDevice")) {
      throw new Error("No platform device selected");
    }
    return { stdout: '"IOPlatformUUID" = "hardware-machine-id"', stderr: "" };
  });
  const { getMachineId } = await import("./machine-id.js");

  await expect(getMachineId()).resolves.toBe("hardware-machine-id");
  expect(fileMocks.writeFile).not.toHaveBeenCalled();
});

test("keeps an existing machine identity when hardware lookup becomes available", async () => {
  fileMocks.readFile.mockResolvedValue("persisted-machine-id\n");
  fileMocks.execFile.mockResolvedValue({
    stdout: '"IOPlatformUUID" = "newly-readable-hardware-id"',
    stderr: "",
  });
  const { getMachineId, readMachineId } = await import("./machine-id.js");

  await expect(getMachineId()).resolves.toBe("persisted-machine-id");
  await expect(readMachineId()).resolves.toBe("persisted-machine-id");
  expect(fileMocks.writeFile).not.toHaveBeenCalled();
});

test("does not mint an identity during discovery", async () => {
  fileMocks.readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  const { readMachineId } = await import("./machine-id.js");

  await expect(readMachineId()).resolves.toBeNull();
  expect(fileMocks.writeFile).not.toHaveBeenCalled();
});

test("discovery and daemon startup use the same hardware identity", async () => {
  fileMocks.readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  fileMocks.execFile.mockResolvedValue({
    stdout: '"IOPlatformUUID" = "hardware-machine-id"',
    stderr: "",
  });
  const { getMachineId, readMachineId } = await import("./machine-id.js");

  await expect(readMachineId()).resolves.toBe("hardware-machine-id");
  await expect(getMachineId()).resolves.toBe("hardware-machine-id");
  expect(fileMocks.writeFile).not.toHaveBeenCalled();
});
