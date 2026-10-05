import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { PRIVATE_FILE_MODE } from "./private-files.js";

const MODE_MASK = 0o777;
const PERMISSIVE_FILE_MODE = 0o644;
const SERVER_ID = "srv_keypair_test";

function createTempHome(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-keypair-"));
}

function instanceKeypairPath(home: string, serverId = SERVER_ID): string {
  return path.join(home, "daemons", serverId, "daemon-keypair.json");
}

describe("daemon keypair persistence", () => {
  test.skipIf(process.platform === "win32")(
    "creates the per-server keypair with private permissions",
    async () => {
      const home = createTempHome();
      try {
        await loadOrCreateDaemonKeyPair(home, { serverId: SERVER_ID });
        expect(statSync(instanceKeypairPath(home)).mode & MODE_MASK).toBe(PRIVATE_FILE_MODE);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "repairs existing per-server keypair permissions when loading",
    async () => {
      const home = createTempHome();
      const keypairPath = instanceKeypairPath(home);
      try {
        const created = await loadOrCreateDaemonKeyPair(home, { serverId: SERVER_ID });
        chmodSync(keypairPath, PERMISSIVE_FILE_MODE);
        const loaded = await loadOrCreateDaemonKeyPair(home, { serverId: SERVER_ID });
        expect(loaded.publicKeyB64).toBe(created.publicKeyB64);
        expect(statSync(keypairPath).mode & MODE_MASK).toBe(PRIVATE_FILE_MODE);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test("adopts the legacy keypair when the persisted server-id matches", async () => {
    const home = createTempHome();
    try {
      const legacy = await loadOrCreateDaemonKeyPair(home);
      writeFileSync(path.join(home, "server-id"), `${SERVER_ID}\n`);

      const adopted = await loadOrCreateDaemonKeyPair(home, { serverId: SERVER_ID });

      expect(adopted.publicKeyB64).toBe(legacy.publicKeyB64);
      expect(readFileSync(instanceKeypairPath(home), "utf8")).toBe(
        readFileSync(path.join(home, "daemon-keypair.json"), "utf8"),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("generates a new keypair without changing legacy state when server-id differs", async () => {
    const home = createTempHome();
    try {
      const legacy = await loadOrCreateDaemonKeyPair(home);
      const legacyBytes = readFileSync(path.join(home, "daemon-keypair.json"), "utf8");
      writeFileSync(path.join(home, "server-id"), "srv_other_machine\n");

      const created = await loadOrCreateDaemonKeyPair(home, { serverId: SERVER_ID });

      expect(created.publicKeyB64).not.toBe(legacy.publicKeyB64);
      expect(readFileSync(path.join(home, "daemon-keypair.json"), "utf8")).toBe(legacyBytes);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("regenerates an unreadable per-server keypair", async () => {
    const home = createTempHome();
    try {
      const created = await loadOrCreateDaemonKeyPair(home, { serverId: SERVER_ID });
      writeFileSync(instanceKeypairPath(home), "not-json");
      const regenerated = await loadOrCreateDaemonKeyPair(home, { serverId: SERVER_ID });
      expect(regenerated.publicKeyB64).not.toBe(created.publicKeyB64);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reads one winner when concurrent regeneration sees a corrupt keypair", async () => {
    const home = createTempHome();
    try {
      await loadOrCreateDaemonKeyPair(home, { serverId: SERVER_ID });
      writeFileSync(instanceKeypairPath(home), "not-json");
      const [first, second] = await Promise.all([
        loadOrCreateDaemonKeyPair(home, { serverId: SERVER_ID }),
        loadOrCreateDaemonKeyPair(home, { serverId: SERVER_ID }),
      ]);
      expect(second.publicKeyB64).toBe(first.publicKeyB64);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reads back the winner when concurrent first creation hits EEXIST", async () => {
    const home = createTempHome();
    try {
      const [first, second] = await Promise.all([
        loadOrCreateDaemonKeyPair(home, { serverId: SERVER_ID }),
        loadOrCreateDaemonKeyPair(home, { serverId: SERVER_ID }),
      ]);

      expect(second.publicKeyB64).toBe(first.publicKeyB64);
      const persisted = JSON.parse(readFileSync(instanceKeypairPath(home), "utf8")) as {
        publicKeyB64: string;
      };
      expect(persisted.publicKeyB64).toBe(first.publicKeyB64);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
