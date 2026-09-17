import { mkdirSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { DirectoryShortcut, InstanceKind, InstanceState } from "@omw/contracts"

export interface InstanceRecord {
  id: string
  kind?: InstanceKind
  clientInvocationId?: string | null
  projectName: string
  projectDirectory: string
  state: InstanceState
  endpoint: string
  port: number
  pid: number | null
  creationTimeUtc: string | null
  creationTimeTicks: string | null
  executable: string | null
  launchedAt: string
  healthVersion: string | null
  stoppedAt: string | null
  error: string | null
  stderrSummary: string | null
}

interface ShortcutRow {
  id: string
  name: string
  directory: string
  created_at: string
  updated_at: string
}

interface InstanceRow {
  id: string
  kind: InstanceKind
  client_invocation_id: string | null
  project_name: string
  project_directory: string
  state: InstanceState
  endpoint: string
  port: number
  pid: number | null
  creation_time_utc: string | null
  creation_time_ticks: string | null
  executable: string | null
  launched_at: string
  health_version: string | null
  stopped_at: string | null
  error: string | null
  stderr_summary: string | null
}

export interface PortAllocation {
  id: string
  kind: InstanceKind
  clientInvocationId: string | null
  projectDirectory: string
  port: number
  createdAt: string
  expiresAt: string | null
  instanceId: string | null
}

interface PortAllocationRow {
  id: string
  kind: InstanceKind
  client_invocation_id: string | null
  project_directory: string
  port: number
  created_at: string
  expires_at: string | null
  instance_id: string | null
}

export class ManagerRepository {
  readonly filename: string
  private readonly database: DatabaseSync
  private closed = false

  constructor(filename: string) {
    this.filename = filename
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true })
    this.database = new DatabaseSync(filename, { timeout: 3_000 })
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS directory_shortcuts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        directory TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS managed_instances (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'headless',
        client_invocation_id TEXT,
        project_name TEXT NOT NULL,
        project_directory TEXT NOT NULL,
        state TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        port INTEGER NOT NULL,
        pid INTEGER,
        creation_time_utc TEXT,
        creation_time_ticks TEXT,
        executable TEXT,
        launched_at TEXT NOT NULL,
        health_version TEXT,
        stopped_at TEXT,
        error TEXT,
        stderr_summary TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS port_allocations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        client_invocation_id TEXT,
        project_directory TEXT NOT NULL,
        port INTEGER NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        instance_id TEXT UNIQUE
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS port_allocations_client_invocation
        ON port_allocations(client_invocation_id) WHERE client_invocation_id IS NOT NULL;
    `)
    this.ensureManagedInstanceColumn("kind", "TEXT NOT NULL DEFAULT 'headless'")
    this.ensureManagedInstanceColumn("client_invocation_id", "TEXT")
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS managed_instances_client_invocation
        ON managed_instances(client_invocation_id) WHERE client_invocation_id IS NOT NULL;
    `)
  }

  close(): void {
    if (this.closed) return
    this.database.close()
    this.closed = true
  }

  listShortcuts(): DirectoryShortcut[] {
    const rows = this.database.prepare("SELECT * FROM directory_shortcuts ORDER BY name COLLATE NOCASE, id").all() as unknown as ShortcutRow[]
    return rows.map(mapShortcut)
  }

  createShortcut(shortcut: DirectoryShortcut): DirectoryShortcut {
    this.database.prepare(`
      INSERT INTO directory_shortcuts (id, name, directory, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(shortcut.id, shortcut.name, shortcut.directory, shortcut.createdAt, shortcut.updatedAt)
    return shortcut
  }

  updateShortcut(shortcut: DirectoryShortcut): DirectoryShortcut | null {
    const result = this.database.prepare(`
      UPDATE directory_shortcuts SET name = ?, directory = ?, updated_at = ? WHERE id = ?
    `).run(shortcut.name, shortcut.directory, shortcut.updatedAt, shortcut.id)
    return result.changes === 0 ? null : shortcut
  }

  getShortcut(id: string): DirectoryShortcut | null {
    const row = this.database.prepare("SELECT * FROM directory_shortcuts WHERE id = ?").get(id) as unknown as ShortcutRow | undefined
    return row ? mapShortcut(row) : null
  }

  deleteShortcut(id: string): boolean {
    return this.database.prepare("DELETE FROM directory_shortcuts WHERE id = ?").run(id).changes > 0
  }

  createInstance(instance: InstanceRecord): InstanceRecord {
    this.database.prepare(`
      INSERT INTO managed_instances (
        id, kind, client_invocation_id, project_name, project_directory, state, endpoint, port, pid,
        creation_time_utc, creation_time_ticks, executable, launched_at,
        health_version, stopped_at, error, stderr_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      instance.id, instance.kind ?? "headless", instance.clientInvocationId ?? null, instance.projectName, instance.projectDirectory, instance.state,
      instance.endpoint, instance.port, instance.pid, instance.creationTimeUtc,
      instance.creationTimeTicks, instance.executable, instance.launchedAt,
      instance.healthVersion, instance.stoppedAt, instance.error, null,
    )
    return instance
  }

  saveInstance(instance: InstanceRecord): InstanceRecord {
    this.database.prepare(`
      UPDATE managed_instances SET
        kind = ?, client_invocation_id = ?, project_name = ?, project_directory = ?, state = ?, endpoint = ?, port = ?, pid = ?,
        creation_time_utc = ?, creation_time_ticks = ?, executable = ?, health_version = ?,
        stopped_at = ?, error = ?
      WHERE id = ?
    `).run(
      instance.kind ?? "headless", instance.clientInvocationId ?? null, instance.projectName, instance.projectDirectory, instance.state, instance.endpoint,
      instance.port, instance.pid, instance.creationTimeUtc, instance.creationTimeTicks,
      instance.executable, instance.healthVersion, instance.stoppedAt, instance.error,
      instance.id,
    )
    return instance
  }

  getInstance(id: string): InstanceRecord | null {
    const row = this.database.prepare("SELECT * FROM managed_instances WHERE id = ?").get(id) as unknown as InstanceRow | undefined
    return row ? mapInstance(row) : null
  }

  listInstances(): InstanceRecord[] {
    const rows = this.database.prepare("SELECT * FROM managed_instances ORDER BY launched_at DESC, id").all() as unknown as InstanceRow[]
    return rows.map(mapInstance)
  }

  getInstanceByInvocation(clientInvocationId: string): InstanceRecord | null {
    const row = this.database.prepare("SELECT * FROM managed_instances WHERE client_invocation_id = ?").get(clientInvocationId) as unknown as InstanceRow | undefined
    return row ? mapInstance(row) : null
  }

  tryCreateAllocation(allocation: PortAllocation): boolean {
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO port_allocations (
          id, kind, client_invocation_id, project_directory, port, created_at, expires_at, instance_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        allocation.id, allocation.kind, allocation.clientInvocationId, allocation.projectDirectory,
        allocation.port, allocation.createdAt, allocation.expiresAt, allocation.instanceId,
      )
      this.database.exec("COMMIT")
      return result.changes === 1
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  createReservedInstance(allocationId: string, instance: InstanceRecord): InstanceRecord {
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const allocation = this.getAllocation(allocationId)
      if (!allocation || allocation.instanceId !== null || allocation.port !== instance.port) {
        throw new Error("Port reservation 不存在、已登錄或與 Instance port 不符。")
      }
      this.createInstance(instance)
      const changed = this.database.prepare(`
        UPDATE port_allocations SET instance_id = ?, expires_at = NULL WHERE id = ? AND instance_id IS NULL
      `).run(instance.id, allocationId).changes
      if (changed !== 1) throw new Error("Port reservation registration race detected.")
      this.database.exec("COMMIT")
      return instance
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  getAllocation(id: string): PortAllocation | null {
    const row = this.database.prepare("SELECT * FROM port_allocations WHERE id = ?").get(id) as unknown as PortAllocationRow | undefined
    return row ? mapAllocation(row) : null
  }

  getAllocationByInvocation(clientInvocationId: string): PortAllocation | null {
    const row = this.database.prepare("SELECT * FROM port_allocations WHERE client_invocation_id = ?").get(clientInvocationId) as unknown as PortAllocationRow | undefined
    return row ? mapAllocation(row) : null
  }

  listExpiredReservations(now: string): PortAllocation[] {
    const rows = this.database.prepare(`
      SELECT * FROM port_allocations
      WHERE instance_id IS NULL AND expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY expires_at, id
    `).all(now) as unknown as PortAllocationRow[]
    return rows.map(mapAllocation)
  }

  extendReservation(id: string, expiresAt: string): void {
    this.database.prepare("UPDATE port_allocations SET expires_at = ? WHERE id = ? AND instance_id IS NULL").run(expiresAt, id)
  }

  releaseReservation(id: string): void {
    this.database.prepare("DELETE FROM port_allocations WHERE id = ? AND instance_id IS NULL").run(id)
  }

  releaseAllocationForInstance(instanceId: string): void {
    this.database.prepare("DELETE FROM port_allocations WHERE instance_id = ?").run(instanceId)
  }

  private ensureManagedInstanceColumn(name: string, definition: string): void {
    const columns = this.database.prepare("PRAGMA table_info(managed_instances)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === name)) {
      this.database.exec(`ALTER TABLE managed_instances ADD COLUMN ${name} ${definition}`)
    }
  }
}

function mapShortcut(row: ShortcutRow): DirectoryShortcut {
  return { id: row.id, name: row.name, directory: row.directory, createdAt: row.created_at, updatedAt: row.updated_at }
}

function mapInstance(row: InstanceRow): InstanceRecord {
  return {
    id: row.id,
    kind: row.kind,
    clientInvocationId: row.client_invocation_id,
    projectName: row.project_name,
    projectDirectory: row.project_directory,
    state: row.state,
    endpoint: row.endpoint,
    port: row.port,
    pid: row.pid,
    creationTimeUtc: row.creation_time_utc,
    creationTimeTicks: row.creation_time_ticks,
    executable: row.executable,
    launchedAt: row.launched_at,
    healthVersion: row.health_version,
    stoppedAt: row.stopped_at,
    error: row.error,
    stderrSummary: null,
  }
}

function mapAllocation(row: PortAllocationRow): PortAllocation {
  return {
    id: row.id,
    kind: row.kind,
    clientInvocationId: row.client_invocation_id,
    projectDirectory: row.project_directory,
    port: row.port,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    instanceId: row.instance_id,
  }
}
