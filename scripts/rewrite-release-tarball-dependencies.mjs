import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMainModule } from "./is-main-module.mjs";

export const releasePackages = [
  {
    name: "@getpaseo/highlight",
    path: "packages/highlight/package.json",
    assetName: "paseo-highlight.tgz",
  },
  {
    name: "@getpaseo/relay",
    path: "packages/relay/package.json",
    assetName: "paseo-relay.tgz",
  },
  {
    name: "@getpaseo/protocol",
    path: "packages/protocol/package.json",
    assetName: "paseo-protocol.tgz",
  },
  {
    name: "@getpaseo/client",
    path: "packages/client/package.json",
    assetName: "paseo-client.tgz",
  },
  {
    name: "@getpaseo/plugin",
    path: "packages/plugin/package.json",
    assetName: "paseo-plugin.tgz",
  },
  {
    name: "@getpaseo/server",
    path: "packages/server/package.json",
    assetName: "paseo-server.tgz",
  },
  {
    name: "@getpaseo/cli",
    path: "packages/cli/package.json",
    assetName: "paseo-cli.tgz",
  },
];

function requireValue(value, name) {
  if (!value?.trim()) throw new Error(`${name} is missing`);
  return value.trim();
}

function getRollingVersion(version, revision) {
  const baseVersion = /^(\d+\.\d+\.\d+)/.exec(version)?.[1];
  if (!baseVersion) throw new Error(`invalid package version ${version}`);
  return `${baseVersion}-rolling.commit-${revision}`;
}

export function rewriteReleaseTarballDependencies({
  repository,
  releaseTag,
  revision,
  rolling = false,
  rootDir,
}) {
  repository = requireValue(repository, "repository");
  releaseTag = requireValue(releaseTag, "releaseTag");
  revision = requireValue(revision, "revision");
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    throw new Error(`revision must be a full Git commit SHA, got ${revision}`);
  }

  const assetUrls = new Map(
    releasePackages.map((pkg) => {
      const assetName = rolling
        ? pkg.assetName.replace(/\.tgz$/, `-${revision}.tgz`)
        : pkg.assetName;
      const url = new URL(
        `https://github.com/${repository}/releases/download/${encodeURIComponent(releaseTag)}/${assetName}`,
      );
      url.searchParams.set("build", revision);
      return [pkg.name, url.toString()];
    }),
  );

  const manifests = new Map(
    releasePackages.map((pkg) => {
      const path = resolve(rootDir, pkg.path);
      const packageJson = JSON.parse(readFileSync(path, "utf8"));
      return [pkg.name, { packageJson, path }];
    }),
  );
  const rollingVersions = new Map(
    rolling
      ? [...manifests].map(([name, { packageJson }]) => [
          name,
          getRollingVersion(packageJson.version, revision),
        ])
      : [],
  );

  for (const pkg of releasePackages) {
    const { packageJson, path } = manifests.get(pkg.name);
    packageJson.paseoBuildCommit = revision;
    if (rolling) packageJson.version = rollingVersions.get(pkg.name);

    for (const field of ["dependencies", "optionalDependencies"]) {
      const dependencies = packageJson[field];
      if (!dependencies) continue;
      for (const dependencyName of Object.keys(dependencies)) {
        const assetUrl = assetUrls.get(dependencyName);
        if (assetUrl) dependencies[dependencyName] = assetUrl;
      }
    }

    if (rolling) {
      for (const dependencyName of Object.keys(packageJson.peerDependencies ?? {})) {
        const version = rollingVersions.get(dependencyName);
        if (version) packageJson.peerDependencies[dependencyName] = version;
      }
    }

    writeFileSync(path, `${JSON.stringify(packageJson, null, 2)}\n`);
  }
}

if (isMainModule(import.meta.url)) {
  rewriteReleaseTarballDependencies({
    repository: process.env.REPOSITORY,
    releaseTag: process.env.RELEASE_TAG,
    revision: process.env.BUILD_COMMIT,
    rolling: process.env.IS_ROLLING_CLI_RELEASE === "true",
    rootDir: process.cwd(),
  });
}
