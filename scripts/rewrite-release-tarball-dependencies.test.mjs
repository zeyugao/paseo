import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  releasePackages,
  rewriteReleaseTarballDependencies,
} from "./rewrite-release-tarball-dependencies.mjs";

const revision = "0123456789abcdef0123456789abcdef01234567";

test("uses commit-specific rolling packages and fixed versioned assets", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "paseo-release-dependencies-"));
  try {
    for (const [index, pkg] of releasePackages.entries()) {
      const packageJsonPath = join(rootDir, pkg.path);
      mkdirSync(dirname(packageJsonPath), { recursive: true });
      const nextPackage = releasePackages[(index + 1) % releasePackages.length];
      writeFileSync(
        packageJsonPath,
        `${JSON.stringify(
          {
            name: pkg.name,
            version: "0.8.0",
            dependencies: { [nextPackage.name]: "0.8.0", zod: "^4.4.3" },
            peerDependencies: { [nextPackage.name]: "0.8.0", react: "^19.1.0" },
          },
          null,
          2,
        )}\n`,
      );
    }

    rewriteReleaseTarballDependencies({
      repository: "getpaseo/paseo",
      releaseTag: "cli-latest",
      revision,
      rolling: true,
      rootDir,
    });

    for (const [index, pkg] of releasePackages.entries()) {
      const nextPackage = releasePackages[(index + 1) % releasePackages.length];
      const rollingVersion = `0.8.0-rolling.commit-${revision}`;
      const packageJson = JSON.parse(readFileSync(join(rootDir, pkg.path), "utf8"));
      assert.equal(packageJson.paseoBuildCommit, revision);
      assert.equal(packageJson.version, rollingVersion);
      assert.equal(packageJson.peerDependencies[nextPackage.name], rollingVersion);
      assert.equal(packageJson.peerDependencies.react, "^19.1.0");
      assert.equal(
        packageJson.dependencies[nextPackage.name],
        `https://github.com/getpaseo/paseo/releases/download/cli-latest/${nextPackage.assetName.replace(/\.tgz$/, `-${revision}.tgz`)}?build=${revision}`,
      );
      assert.equal(packageJson.dependencies.zod, "^4.4.3");
    }

    rewriteReleaseTarballDependencies({
      repository: "getpaseo/paseo",
      releaseTag: "v0.8.0",
      revision,
      rootDir,
    });

    for (const [index, pkg] of releasePackages.entries()) {
      const nextPackage = releasePackages[(index + 1) % releasePackages.length];
      const packageJson = JSON.parse(readFileSync(join(rootDir, pkg.path), "utf8"));
      assert.equal(
        packageJson.dependencies[nextPackage.name],
        `https://github.com/getpaseo/paseo/releases/download/v0.8.0/${nextPackage.assetName}?build=${revision}`,
      );
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("rejects a revision that cannot identify one release build", () => {
  assert.throws(
    () =>
      rewriteReleaseTarballDependencies({
        repository: "getpaseo/paseo",
        releaseTag: "cli-latest",
        revision: "main",
        rootDir: process.cwd(),
      }),
    /full Git commit SHA/,
  );
});
