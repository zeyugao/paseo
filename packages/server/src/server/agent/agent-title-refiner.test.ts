import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { AgentTitleRefiner } from "./agent-title-refiner.js";
import type { StructuredAgentGenerationWithFallbackOptions } from "./agent-response-loop.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

const logger = createTestLogger();

const PROMPT = "Fix the login validation bug on mobile\n\nThe form submits twice on iOS.";
const PROVISIONAL_TITLE = "Fix the login validation bug on mobile";
const REPLY = "I fixed the double-submit by debouncing the form submit handler.";

type FakeGenerate = <T>(options: StructuredAgentGenerationWithFallbackOptions<T>) => Promise<T>;

interface FakeGenerator {
  generate: FakeGenerate;
  calls: StructuredAgentGenerationWithFallbackOptions<unknown>[];
}

function createFakeGenerator(result: { title: string } | Error): FakeGenerator {
  const calls: StructuredAgentGenerationWithFallbackOptions<unknown>[] = [];
  const generate = async <T>(
    options: StructuredAgentGenerationWithFallbackOptions<T>,
  ): Promise<T> => {
    calls.push(options as StructuredAgentGenerationWithFallbackOptions<unknown>);
    if (result instanceof Error) throw result;
    return result as T;
  };
  return { generate, calls };
}

function createDeferredFakeGenerator(): FakeGenerator & {
  resolve: (value: { title: string }) => void;
} {
  const calls: StructuredAgentGenerationWithFallbackOptions<unknown>[] = [];
  let resolveResult: ((value: { title: string }) => void) | null = null;
  const generate = async <T>(
    options: StructuredAgentGenerationWithFallbackOptions<T>,
  ): Promise<T> => {
    calls.push(options as StructuredAgentGenerationWithFallbackOptions<unknown>);
    const value = await new Promise<{ title: string }>((resolve) => {
      resolveResult = resolve;
    });
    return value as T;
  };
  return {
    generate,
    calls,
    resolve: (value) => resolveResult?.(value),
  };
}

interface Harness {
  manager: AgentManager;
  storage: AgentStorage;
  refiner: AgentTitleRefiner;
  workdir: string;
  agentIds: string[];
}

function createHarness(generate: FakeGenerate): Harness {
  const workdir = mkdtempSync(join(tmpdir(), "agent-title-refiner-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = createTestAgentClients().codex;
  if (!client) {
    throw new Error("expected Codex test client");
  }
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });
  const refiner = new AgentTitleRefiner({
    agentManager: manager,
    agentStorage: storage,
    readDaemonConfig: () => ({}),
    logger,
    deps: { generateStructuredAgentResponseWithFallback: generate },
  });
  return { manager, storage, refiner, workdir, agentIds: [] };
}

async function createAgentWithTitle(harness: Harness, title: string | null): Promise<string> {
  const snapshot = await harness.manager.createAgent(
    { provider: "codex", cwd: harness.workdir },
    undefined,
    { workspaceId: undefined },
  );
  harness.agentIds.push(snapshot.id);
  if (title) {
    await harness.manager.setTitle(snapshot.id, title);
  }
  return snapshot.id;
}

async function appendFirstTurn(harness: Harness, agentId: string): Promise<void> {
  await harness.manager.appendTimelineItem(agentId, { type: "user_message", text: PROMPT });
  await harness.manager.appendTimelineItem(agentId, { type: "assistant_message", text: REPLY });
}

const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (!harness) break;
    for (const agentId of harness.agentIds) {
      await harness.manager.closeAgent(agentId).catch(() => undefined);
    }
    rmSync(harness.workdir, { recursive: true, force: true });
  }
});

function track(harness: Harness): Harness {
  harnesses.push(harness);
  return harness;
}

test("replaces the prompt-derived provisional title after the first turn", async () => {
  const fake = createFakeGenerator({ title: "Fix login double submit" });
  const harness = track(createHarness(fake.generate));
  const agentId = await createAgentWithTitle(harness, PROVISIONAL_TITLE);
  await appendFirstTurn(harness, agentId);

  await harness.refiner.refine(agentId);

  expect(await harness.storage.get(agentId)).toMatchObject({ title: "Fix login double submit" });
  expect(fake.calls).toHaveLength(1);
  const call = fake.calls[0];
  expect(call.schemaName).toBe("AgentTitle");
  expect(call.persistSession).toBe(false);
  expect(call.agentConfigOverrides).toMatchObject({ internal: true });
  // The full prompt (both lines) and the final reply are passed through uncut.
  expect(call.prompt).toContain(PROMPT);
  expect(call.prompt).toContain(REPLY);
});

test("refines an agent that never received a title", async () => {
  const fake = createFakeGenerator({ title: "Fix login double submit" });
  const harness = track(createHarness(fake.generate));
  const agentId = await createAgentWithTitle(harness, null);
  await appendFirstTurn(harness, agentId);

  await harness.refiner.refine(agentId);

  expect(await harness.storage.get(agentId)).toMatchObject({ title: "Fix login double submit" });
});

test("keeps a title that no longer matches the prompt-derived provisional", async () => {
  const fake = createFakeGenerator({ title: "Generated" });
  const harness = track(createHarness(fake.generate));
  // Covers both manual renames and explicit create-time titles (subagents).
  const agentId = await createAgentWithTitle(harness, "Manual name");
  await appendFirstTurn(harness, agentId);

  await harness.refiner.refine(agentId);

  expect(fake.calls).toHaveLength(0);
  expect(await harness.storage.get(agentId)).toMatchObject({ title: "Manual name" });
});

test("a manual rename landing during generation wins", async () => {
  const fake = createDeferredFakeGenerator();
  const harness = track(createHarness(fake.generate));
  const agentId = await createAgentWithTitle(harness, PROVISIONAL_TITLE);
  await appendFirstTurn(harness, agentId);

  const refining = harness.refiner.refine(agentId);
  await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
  await harness.manager.setTitle(agentId, "Manual name");
  fake.resolve({ title: "Generated" });
  await refining;

  expect(await harness.storage.get(agentId)).toMatchObject({ title: "Manual name" });
});

test("keeps the provisional title when generation fails", async () => {
  const fake = createFakeGenerator(new Error("provider unavailable"));
  const harness = track(createHarness(fake.generate));
  const agentId = await createAgentWithTitle(harness, PROVISIONAL_TITLE);
  await appendFirstTurn(harness, agentId);

  await expect(harness.refiner.refine(agentId)).resolves.toBeUndefined();

  expect(await harness.storage.get(agentId)).toMatchObject({ title: PROVISIONAL_TITLE });
});

test("skips agents without a user message in the timeline", async () => {
  const fake = createFakeGenerator({ title: "Generated" });
  const harness = track(createHarness(fake.generate));
  const agentId = await createAgentWithTitle(harness, PROVISIONAL_TITLE);
  await harness.manager.appendTimelineItem(agentId, { type: "assistant_message", text: REPLY });

  await harness.refiner.refine(agentId);

  expect(fake.calls).toHaveLength(0);
  expect(await harness.storage.get(agentId)).toMatchObject({ title: PROVISIONAL_TITLE });
});

test("ignores a blank generated title", async () => {
  const fake = createFakeGenerator({ title: "   " });
  const harness = track(createHarness(fake.generate));
  const agentId = await createAgentWithTitle(harness, PROVISIONAL_TITLE);
  await appendFirstTurn(harness, agentId);

  await harness.refiner.refine(agentId);

  expect(await harness.storage.get(agentId)).toMatchObject({ title: PROVISIONAL_TITLE });
});

test("collapses concurrent refinements for the same agent into one generation", async () => {
  const fake = createDeferredFakeGenerator();
  const harness = track(createHarness(fake.generate));
  const agentId = await createAgentWithTitle(harness, PROVISIONAL_TITLE);
  await appendFirstTurn(harness, agentId);

  const first = harness.refiner.refine(agentId);
  const second = harness.refiner.refine(agentId);
  await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
  fake.resolve({ title: "Generated" });
  await Promise.all([first, second]);

  expect(fake.calls).toHaveLength(1);
  expect(await harness.storage.get(agentId)).toMatchObject({ title: "Generated" });
});
