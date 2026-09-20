import { createHash } from "node:crypto"
import { lstat, stat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export type IsolationMode = "development" | "test" | "acceptance"

export interface IsolationPaths {
  root: string
  omwData: string
  home: string
  temporary: string
  appDataRoaming: string
  appDataLocal: string
  configDirectory: string
  configFile: string
  managedConfigDirectory: string
  openCodeDatabase: string
  xdgConfig: string
  xdgData: string
  xdgCache: string
  xdgState: string
  xdgRuntime: string
}

export interface IsolationContext {
  mode: IsolationMode
  persistent: boolean
  ownedRoot: boolean
  paths: IsolationPaths
  environment: NodeJS.ProcessEnv
  dispose(): Promise<void>
}

export interface PrepareIsolationOptions {
  mode: IsolationMode
  root: string
  sourceEnvironment?: NodeJS.ProcessEnv
  configFile?: string
  sharedConfigFile?: string
  portIdentity?: string
  ownedRoot?: boolean
}

const RUNTIME_KEYS = [
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATH",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "LANG",
  "LC_ALL",
  "TERM",
  "CI",
  "FORCE_COLOR",
  "NODE_EXTRA_CA_CERTS",
] as const

const EXPLICIT_TOOL_KEYS = [
  "OMW_OPENCODE_EXECUTABLE",
  "OMW_POWERSHELL_EXECUTABLE",
  "OMW_BROWSER_EXECUTABLE",
  "OMW_REAL_OPENCODE_TEST",
  "OMW_BROWSER_TEST",
] as const

const MINIMAL_CONFIG = `${JSON.stringify({ plugin: [], mcp: {} }, null, 2)}\n`

export async function prepareIsolatedEnvironment(options: PrepareIsolationOptions): Promise<IsolationContext> {
  const root = path.resolve(options.root)
  const paths = isolationPaths(root)
  const persistent = options.mode === "development"
  const ownedRoot = options.ownedRoot === true
  if (persistent && ownedRoot) throw new Error("Persistent development isolation cannot own and dispose its root.")
  if (options.configFile !== undefined && options.sharedConfigFile !== undefined) {
    throw new Error("Use either an isolated configFile or an explicit sharedConfigFile, not both.")
  }
  const requestedConfig = options.configFile === undefined ? paths.configFile : path.resolve(options.configFile)
  let configFile = requestedConfig
  let sharedConfigSnapshot: Buffer | undefined

  try {
    await assertDirectIsolationPaths(paths)
    if (options.configFile !== undefined) {
      if (!isInside(root, requestedConfig)) throw new Error("Isolated configFile must stay inside the isolation root.")
      await assertDirectPath(requestedConfig)
      if (!(await stat(requestedConfig)).isFile()) throw new Error("Isolated configFile must identify a regular file.")
    }
    if (options.sharedConfigFile !== undefined) {
      if (options.mode !== "development") throw new Error("Shared OpenCode config is only available for explicit development opt-in.")
      if (!path.isAbsolute(options.sharedConfigFile)) throw new Error("OMW_DEV_SHARED_CONFIG must be an absolute file path.")
      const shared = await realpath(options.sharedConfigFile)
      if (!(await stat(shared)).isFile()) throw new Error("OMW_DEV_SHARED_CONFIG must identify a regular file.")
      sharedConfigSnapshot = await readFile(shared)
      configFile = paths.configFile
    }

    await Promise.all([
      mkdir(paths.omwData, { recursive: true }),
      mkdir(paths.home, { recursive: true }),
      mkdir(paths.temporary, { recursive: true }),
      mkdir(paths.appDataRoaming, { recursive: true }),
      mkdir(paths.appDataLocal, { recursive: true }),
      mkdir(paths.configDirectory, { recursive: true }),
      mkdir(paths.managedConfigDirectory, { recursive: true }),
      mkdir(path.dirname(paths.openCodeDatabase), { recursive: true }),
      mkdir(paths.xdgConfig, { recursive: true }),
      mkdir(paths.xdgData, { recursive: true }),
      mkdir(paths.xdgCache, { recursive: true }),
      mkdir(paths.xdgState, { recursive: true }),
      mkdir(paths.xdgRuntime, { recursive: true }),
    ])
    await assertDirectIsolationPaths(paths)
    if (options.configFile === undefined) {
      // OpenCode 1.18.31 may write back to OPENCODE_CONFIG, so even an explicit shared source is copied into the guarded private target.
      await writeFile(paths.configFile, sharedConfigSnapshot ?? MINIMAL_CONFIG)
    }

    const environment = createIsolatedEnvironment({
      mode: options.mode,
      paths,
      configFile,
      sourceEnvironment: options.sourceEnvironment ?? process.env,
      portIdentity: options.portIdentity ?? root,
    })
    const contextPaths = configFile === paths.configFile ? paths : { ...paths, configFile }

    return {
      mode: options.mode,
      persistent,
      ownedRoot,
      paths: contextPaths,
      environment,
      async dispose() {
        if (!ownedRoot) return
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (ownedRoot) await rm(root, { recursive: true, force: true })
    throw error
  }
}

export function isolationPaths(root: string): IsolationPaths {
  const absoluteRoot = path.resolve(root)
  const home = path.join(absoluteRoot, "home")
  const appData = path.join(home, "AppData")
  const xdg = path.join(absoluteRoot, "xdg")
  return {
    root: absoluteRoot,
    omwData: path.join(absoluteRoot, "omw"),
    home,
    temporary: path.join(absoluteRoot, "temp"),
    appDataRoaming: path.join(appData, "Roaming"),
    appDataLocal: path.join(appData, "Local"),
    configDirectory: path.join(absoluteRoot, "opencode", "config"),
    configFile: path.join(absoluteRoot, "opencode", "config", "opencode.json"),
    managedConfigDirectory: path.join(absoluteRoot, "opencode", "managed-config"),
    openCodeDatabase: path.join(absoluteRoot, "opencode", "db", "opencode.sqlite"),
    xdgConfig: path.join(xdg, "config"),
    xdgData: path.join(xdg, "data"),
    xdgCache: path.join(xdg, "cache"),
    xdgState: path.join(xdg, "state"),
    xdgRuntime: path.join(xdg, "runtime"),
  }
}

export function createIsolatedEnvironment(options: {
  mode: IsolationMode
  paths: IsolationPaths
  configFile: string
  sourceEnvironment: NodeJS.ProcessEnv
  portIdentity?: string
}): NodeJS.ProcessEnv {
  const environment = allowlistedEnvironment(options.sourceEnvironment)
  const ports = isolatedPorts(options.portIdentity ?? options.paths.root)

  Object.assign(environment, {
    HOME: options.paths.home,
    USERPROFILE: options.paths.home,
    APPDATA: options.paths.appDataRoaming,
    LOCALAPPDATA: options.paths.appDataLocal,
    TEMP: options.paths.temporary,
    TMP: options.paths.temporary,
    XDG_CONFIG_HOME: options.paths.xdgConfig,
    XDG_DATA_HOME: options.paths.xdgData,
    XDG_CACHE_HOME: options.paths.xdgCache,
    XDG_STATE_HOME: options.paths.xdgState,
    XDG_RUNTIME_DIR: options.paths.xdgRuntime,
    OMW_DATA_DIR: options.paths.omwData,
    OMW_PORT: String(ports.manager),
    OMW_INSTANCE_PORT_MIN: String(ports.instanceMin),
    OMW_INSTANCE_PORT_MAX: String(ports.instanceMax),
    OPENCODE_TEST_HOME: options.paths.home,
    OPENCODE_DB: options.paths.openCodeDatabase,
    OPENCODE_CONFIG: path.resolve(options.configFile),
    OPENCODE_CONFIG_DIR: options.paths.configDirectory,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_PRUNE: "1",
    OPENCODE_AUTO_SHARE: "false",
  })
  if (options.mode !== "development") {
    // 這是綁定 OpenCode 1.18.31 的 test-only seam；development 不可用它遮蔽 machine managed policy。
    environment.OPENCODE_TEST_MANAGED_CONFIG_DIR = options.paths.managedConfigDirectory
  }
  return environment
}

export function isolatedPorts(identity: string): { manager: number; instanceMin: number; instanceMax: number } {
  const digest = createHash("sha256").update(path.resolve(identity).toLowerCase()).digest()
  const manager = 43_000 + digest.readUInt32BE(0) % 1_000
  const instanceMin = 44_000 + digest.readUInt32BE(4) % 200 * 100
  return { manager, instanceMin, instanceMax: instanceMin + 99 }
}

function allowlistedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const byUpperName = new Map(Object.entries(source).map(([name, value]) => [name.toUpperCase(), value]))
  const result: NodeJS.ProcessEnv = {}
  for (const name of [...RUNTIME_KEYS, ...EXPLICIT_TOOL_KEYS]) {
    const value = byUpperName.get(name)
    if (value !== undefined) result[name] = value
  }
  return result
}

async function assertDirectIsolationPaths(paths: IsolationPaths): Promise<void> {
  const existingAncestor = await nearestExistingPath(paths.root)
  await assertDirectPath(existingAncestor)
  for (const candidate of mutableIsolationPaths(paths)) await assertDirectPath(candidate, true)
}

function mutableIsolationPaths(paths: IsolationPaths): string[] {
  const endpoints = [
    paths.root,
    paths.omwData,
    path.join(paths.omwData, "credentials.dpapi"),
    path.join(paths.omwData, "omw.sqlite"),
    path.join(paths.omwData, "omw.sqlite-wal"),
    path.join(paths.omwData, "omw.sqlite-shm"),
    paths.home,
    paths.appDataRoaming,
    paths.appDataLocal,
    paths.temporary,
    paths.configDirectory,
    paths.configFile,
    paths.managedConfigDirectory,
    paths.openCodeDatabase,
    `${paths.openCodeDatabase}-wal`,
    `${paths.openCodeDatabase}-shm`,
    paths.xdgConfig,
    paths.xdgData,
    paths.xdgCache,
    paths.xdgState,
    paths.xdgRuntime,
  ]
  const candidates = new Set<string>()
  for (const endpoint of endpoints) {
    let candidate = endpoint
    while (isInside(paths.root, candidate)) {
      candidates.add(candidate)
      if (samePath(candidate, paths.root)) break
      candidate = path.dirname(candidate)
    }
  }
  return [...candidates].sort((left, right) => left.length - right.length)
}

async function nearestExistingPath(candidate: string): Promise<string> {
  let current = candidate
  while (true) {
    try {
      await lstat(current)
      return current
    } catch (cause) {
      if (!isMissing(cause)) throw cause
      const parent = path.dirname(current)
      if (samePath(parent, current)) throw cause
      current = parent
    }
  }
}

async function assertDirectPath(candidate: string, missingAllowed = false): Promise<void> {
  try {
    const information = await lstat(candidate)
    if (information.isSymbolicLink()) throw isolationAliasError(candidate)
    if (information.isFile() && information.nlink > 1) throw isolationHardLinkError(candidate)
    if (!samePath(await realpath(candidate), candidate)) throw isolationAliasError(candidate)
  } catch (cause) {
    if (missingAllowed && isMissing(cause)) return
    throw cause
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value).replace(/^\\\\\?\\/, "")
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function isMissing(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT"
}

function isolationAliasError(candidate: string): Error {
  return new Error(`Isolation mutable path cannot be a symlink, junction, or canonical alias: ${candidate}`)
}

function isolationHardLinkError(candidate: string): Error {
  return new Error(`Isolation mutable file cannot have multiple hard links: ${candidate}`)
}
