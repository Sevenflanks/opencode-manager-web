import { createHash } from "node:crypto"
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = path.resolve(packageRoot, "../..")
const webRoot = path.join(repositoryRoot, "apps/web")
const outputPath = path.join(packageRoot, "THIRD_PARTY_NOTICES.md")
const licenseFilePattern = /^(?:licen[cs]e|copying|copyright)(?:[._ -].*)?$/i
const noticeFilePattern = /^notice(?:[._ -].*)?$/i
// npm 的 @vue/devtools-api@6.6.4 tarball 未附 LICENSE；只接受這個版本已核對的 upstream 全文。
// 新版或內容變動必須重新確認來源，其他缺全文的套件仍維持 fail-closed。
const upstreamLicenseExceptions = new Map([
  ["@vue/devtools-api@6.6.4", {
    path: path.join(packageRoot, "licenses/vue-devtools-api-6.6.4-LICENSE"),
    source: "https://github.com/vuejs/vue-devtools/blob/v6.6.4/LICENSE",
    sha256: "050bbca6960784db52ff387271bf2ecc5cbed7cf8581b415d528a6ecb6585015",
  }],
])

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"))
}

async function isDirectory(directoryPath) {
  try {
    return (await stat(directoryPath)).isDirectory()
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return false
    }
    throw error
  }
}

async function resolvePackageDirectory(packageName, issuerDirectory) {
  let current = issuerDirectory

  while (true) {
    const candidate = path.join(current, "node_modules", ...packageName.split("/"))
    if (await isDirectory(candidate)) {
      return realpath(candidate)
    }

    const parent = path.dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

function packageSource(manifest) {
  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url
  return (repository ?? manifest.homepage ?? "Not provided")
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "")
}

function declaredLicense(manifest) {
  if (typeof manifest.license === "string") {
    return manifest.license
  }
  return JSON.stringify(manifest.license ?? manifest.licenses ?? "Not provided")
}

async function productionDependencyNames(manifest) {
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])

  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    if (!manifest.peerDependenciesMeta?.[name]?.optional) {
      names.add(name)
    }
  }

  return [...names].filter((name) => !name.startsWith("@omw/")).sort()
}

async function collectProductionClosure() {
  const webManifest = await readJson(path.join(webRoot, "package.json"))
  const queue = (await productionDependencyNames(webManifest)).map((name) => ({
    name,
    issuerDirectory: webRoot,
    required: true,
  }))
  const packages = new Map()

  while (queue.length > 0) {
    const dependency = queue.shift()
    const directory = await resolvePackageDirectory(dependency.name, dependency.issuerDirectory)
    if (!directory) {
      if (dependency.required) {
        throw new Error(`Unable to resolve production dependency ${dependency.name} from ${dependency.issuerDirectory}`)
      }
      continue
    }

    const manifest = await readJson(path.join(directory, "package.json"))
    const key = `${manifest.name}@${manifest.version}`
    if (packages.has(key)) {
      continue
    }

    packages.set(key, { directory, manifest })

    const optionalNames = new Set(Object.keys(manifest.optionalDependencies ?? {}))
    for (const name of await productionDependencyNames(manifest)) {
      queue.push({
        name,
        issuerDirectory: directory,
        required: !optionalNames.has(name),
      })
    }
  }

  return [...packages.entries()].sort(([left], [right]) => left.localeCompare(right))
}

async function collectLicenseFiles(packageKey, directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const names = entries
    .filter((entry) => entry.isFile() && (licenseFilePattern.test(entry.name) || noticeFilePattern.test(entry.name)))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))

  if (!names.some((name) => licenseFilePattern.test(name))) {
    const exception = upstreamLicenseExceptions.get(packageKey)
    if (exception) {
      const bytes = await readFile(exception.path)
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      if (sha256 !== exception.sha256) throw new Error(`${packageKey} verified upstream license text does not match ${exception.sha256}`)
      return [{
        name: "LICENSE",
        sha256,
        text: bytes.toString("utf8").replace(/\r\n/g, "\n").trimEnd(),
        source: exception.source,
      }]
    }
    throw new Error(`${packageKey} has no upstream license text file in ${directory}`)
  }

  return Promise.all(names.map(async (name) => {
    const bytes = await readFile(path.join(directory, name))
    return {
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      text: bytes.toString("utf8").replace(/\r\n/g, "\n").trimEnd(),
    }
  }))
}

const packages = await collectProductionClosure()
const sections = []
let licenseFileCount = 0
let noticeFileCount = 0

for (const [key, { directory, manifest }] of packages) {
  const files = await collectLicenseFiles(key, directory)
  licenseFileCount += files.filter((file) => licenseFilePattern.test(file.name)).length
  noticeFileCount += files.filter((file) => noticeFilePattern.test(file.name)).length
  const fileSections = files.map((file) => [
    `### Upstream \`${file.name}\``,
    "",
    ...(file.source ? [`Source (verified upstream repository, absent from npm tarball): <${file.source}>`] : []),
    file.source ? `SHA-256 of verified upstream license text: \`${file.sha256}\`` : `SHA-256 of installed upstream file: \`${file.sha256}\``,
    "",
    "````text",
    file.text,
    "````",
  ].join("\n"))

  sections.push([
    `## \`${key}\``,
    "",
    `- Declared license: \`${declaredLicense(manifest)}\``,
    `- Source: <${packageSource(manifest)}>`,
    "",
    ...fileSections,
  ].join("\n"))
}

const packageList = packages.map(([key]) => `- \`${key}\``).join("\n")
const output = [
  "# Third-Party Notices",
  "",
  "The OMW Web application bundles third-party code into its browser assets. The packages below are the conservative installed production dependency closure rooted at `apps/web/package.json`: regular dependencies, installed optional dependencies, and required peer dependencies are included recursively. OMW workspace packages and dev-only build dependencies are excluded.",
  "",
  "These components are not licensed under the OMW Sustainable Use License. Each remains subject to the terms and notices reproduced from the corresponding installed npm package, or a version-verified upstream repository license when the npm tarball omitted its text. A package's `NOTICE` file is reproduced when its installed package contains one.",
  "",
  `Generated package count: ${packages.length}`,
  `Included upstream license text files: ${licenseFileCount}`,
  `Included upstream NOTICE files: ${noticeFileCount}`,
  "",
  "## Covered Packages",
  "",
  packageList,
  "",
  ...sections,
  "",
].join("\n")

await writeFile(outputPath, output, "utf8")
console.log(`Generated ${path.relative(repositoryRoot, outputPath)} for ${packages.length} Web production packages.`)
