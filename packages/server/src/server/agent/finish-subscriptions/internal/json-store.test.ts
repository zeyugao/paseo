import { lstat, mkdtemp, rm, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createJsonFinishSubscriptionStore } from "../index.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function temporaryHome() {
  const result = await mkdtemp(join(tmpdir(), "finish-subscriptions-"));
  homes.push(result);
  return result;
}
const subscription = {
  id: "subscription",
  callerAgentId: "parent",
  childAgentId: "child",
  serverId: "remote",
};

test("acknowledged concurrent writes survive reopening and removal", async () => {
  const directory = await temporaryHome();
  const store = createJsonFinishSubscriptionStore(directory);
  await Promise.all([store.put(subscription), store.put({ ...subscription, id: "second" })]);
  const restarted = createJsonFinishSubscriptionStore(directory);
  expect(await restarted.list()).toEqual([subscription, { ...subscription, id: "second" }]);
  await restarted.remove(subscription.id);
  expect(await createJsonFinishSubscriptionStore(directory).list()).toEqual([
    { ...subscription, id: "second" },
  ]);
});

test("independently loaded stores preserve sequential additions and observe removals", async () => {
  const directory = await temporaryHome();
  const first = createJsonFinishSubscriptionStore(directory);
  const second = createJsonFinishSubscriptionStore(directory);
  expect(await first.list()).toEqual([]);
  expect(await second.list()).toEqual([]);
  const other = { ...subscription, id: "second" };

  await first.put(subscription);
  expect(await second.list()).toEqual([subscription]);
  await second.put(other);
  expect(await first.list()).toEqual([subscription, other]);
  await first.remove(subscription.id);
  expect(await second.list()).toEqual([other]);
  await second.put({ ...other, childAgentId: "updated-child" });

  expect(await createJsonFinishSubscriptionStore(directory).list()).toEqual([
    { ...other, childAgentId: "updated-child" },
  ]);
});

test("independent concurrent additions and removals do not overwrite one another", async () => {
  const directory = await temporaryHome();
  const first = createJsonFinishSubscriptionStore(directory);
  const second = createJsonFinishSubscriptionStore(directory);
  await Promise.all([first.list(), second.list()]);
  const other = { ...subscription, id: "second" };
  await Promise.all([first.put(subscription), second.put(other)]);
  expect((await first.list()).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
    other,
    subscription,
  ]);

  const third = { ...subscription, id: "third" };
  await Promise.all([first.remove(subscription.id), second.put(third)]);
  expect((await second.list()).sort((a, b) => a.id.localeCompare(b.id))).toEqual([other, third]);
  expect(await createJsonFinishSubscriptionStore(directory).list()).toEqual(await first.list());
});

test.skipIf(process.platform === "win32")(
  "shared store writes preserve a symlink and update its target",
  async () => {
    const directory = await temporaryHome();
    const target = join(directory, "subscriptions-target.json");
    const file = join(directory, "finish-subscriptions.json");
    await writeFile(target, "[]");
    await symlink(target, file);
    const first = createJsonFinishSubscriptionStore(directory);
    const second = createJsonFinishSubscriptionStore(directory);
    await Promise.all([first.put(subscription), second.put({ ...subscription, id: "second" })]);

    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(await first.list());
    expect(await second.list()).toHaveLength(2);
  },
);

test.skipIf(process.platform === "win32")(
  "a dangling symlink rejects writes without replacing the link",
  async () => {
    const directory = await temporaryHome();
    const file = join(directory, "finish-subscriptions.json");
    await symlink(join(directory, "missing.json"), file);
    await expect(createJsonFinishSubscriptionStore(directory).put(subscription)).rejects.toThrow();
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
  },
);

test("write failure rejects registration and does not publish an unwritten record", async () => {
  const directory = await temporaryHome();
  const store = createJsonFinishSubscriptionStore(directory);
  expect(await store.list()).toEqual([]);
  await mkdir(join(directory, "finish-subscriptions.json"));
  await expect(store.put(subscription)).rejects.toThrow();
  await expect(store.list()).rejects.toThrow();
  await rm(join(directory, "finish-subscriptions.json"), { recursive: true });
  expect(await store.list()).toEqual([]);
});

test("invalid persisted records fail visibly", async () => {
  const directory = await temporaryHome();
  const file = join(directory, "finish-subscriptions.json");
  const invalid = JSON.stringify([{ callerAgentId: 42 }]);
  await writeFile(file, invalid);
  const store = createJsonFinishSubscriptionStore(directory);
  await expect(store.list()).rejects.toThrow();
  await expect(store.put(subscription)).rejects.toThrow();
  await expect(store.remove(subscription.id)).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(invalid);
});
