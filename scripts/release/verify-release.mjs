import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const releaseCatalog = [
  {
    manifest: "package.json",
    lockfile: "",
    name: "opencode-manager-web",
    private: true,
  },
  {
    manifest: "apps/manager/package.json",
    lockfile: "apps/manager",
    name: "@omw/manager",
    private: true,
    dependency: "dependencies",
  },
  {
    manifest: "apps/web/package.json",
    lockfile: "apps/web",
    name: "@omw/web",
    private: true,
    dependency: "dependencies",
  },
  {
    manifest: "packages/contracts/package.json",
    lockfile: "packages/contracts",
    name: "@omw/contracts",
    private: true,
  },
  {
    manifest: "packages/launcher/package.json",
    lockfile: "packages/launcher",
    name: "@sevenflanks/omw",
    private: false,
    dependency: "devDependencies",
  },
];

export function versionFromTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag ?? "");
  if (!match) {
    throw new Error("Expected a tag in the form vMAJOR.MINOR.PATCH");
  }
  return match.slice(1).join(".");
}

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

function checkPackage(errors, label, contents, expected, dependencyField) {
  if (contents.version !== expected) {
    errors.push(
      `${label} version: expected ${expected}, found ${contents.version ?? "<missing>"}`,
    );
  }
  if (
    dependencyField &&
    contents[dependencyField]?.["@omw/contracts"] !== expected
  ) {
    errors.push(
      `${label} @omw/contracts: expected ${expected}, found ${contents[dependencyField]?.["@omw/contracts"] ?? "<missing>"}`,
    );
  }
}

export async function verifyRelease(root, tag) {
  const version = versionFromTag(tag);
  const errors = [];

  const lockfile = await readJson(root, "package-lock.json");
  if (lockfile.version !== version) {
    errors.push(
      `package-lock.json version: expected ${version}, found ${lockfile.version ?? "<missing>"}`,
    );
  }

  for (const entry of releaseCatalog) {
    const contents = await readJson(root, entry.manifest);
    if (contents.name !== entry.name) {
      errors.push(
        `${entry.manifest} name: expected ${entry.name}, found ${contents.name ?? "<missing>"}`,
      );
    }
    if (contents.private !== entry.private) {
      errors.push(
        `${entry.manifest} private: expected ${entry.private}, found ${contents.private ?? "<missing>"}`,
      );
    }
    checkPackage(errors, entry.manifest, contents, version, entry.dependency);

    const lockedContents = lockfile.packages?.[entry.lockfile] ?? {};
    checkPackage(
      errors,
      `package-lock.json packages[${JSON.stringify(entry.lockfile)}]`,
      lockedContents,
      version,
      entry.dependency,
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Release version state is inconsistent:\n- ${errors.join("\n- ")}`,
    );
  }

  return { packageName: "@sevenflanks/omw", version };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const result = await verifyRelease(process.cwd(), process.argv[2]);
  console.log(
    `${result.packageName}@${result.version} is synchronized with ${process.argv[2]}`,
  );
}
