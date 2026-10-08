import { mkdirSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { DirectoryShortcut, InstanceKind, InstanceState, PrimarySession } from "@omw/contracts"

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
  trackingHidden?: boolean
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
  tracking_hidden: number
}

interface PrimarySessionRow {
  session_id: string
  title: string
  source: PrimarySession["source"]
  bound_at: string
}

export interface PortAllocation {
  allocationScope?: string
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
  allocation_scope: string | null
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
        stderr_summary TEXT,
        tracking_hidden INTEGER NOT NULL DEFAULT 0 CHECK (tracking_hidden IN (0, 1))
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
      CREATE TABLE IF NOT EXISTS instance_primary_sessions (
        instance_id TEXT PRIMARY KEY REFERENCES managed_instances(id),
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('activity', 'new-session', 'manual')),
        bound_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS port_allocations_client_invocation
        ON port_allocations(client_invocation_id) WHERE client_invocation_id IS NOT NULL;
    `)
    this.ensureManagedInstanceColumn("kind", "TEXT NOT NULL DEFAULT 'headless'")
    this.ensureManagedInstanceColumn("client_invocation_id", "TEXT")
    this.ensureManagedInstanceColumn("tracking_hidden", "INTEGER NOT NULL DEFAULT 0")
    const allocationColumns = this.database.prepare("PRAGMA table_info(port_allocations)").all() as Array<{ name: string }>
    if (!allocationColumns.some((column) => column.name === "allocation_scope")) this.database.exec("ALTER TABLE port_allocations ADD COLUMN allocation_scope TEXT")
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
        health_version, stopped_at, error, stderr_summary, tracking_hidden
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      instance.id, instance.kind ?? "headless", instance.clientInvocationId ?? null, instance.projectName, instance.projectDirectory, instance.state,
      instance.endpoint, instance.port, instance.pid, instance.creationTimeUtc,
      instance.creationTimeTicks, instance.executable, instance.launchedAt,
      instance.healthVersion, instance.stoppedAt, instance.error, null, instance.trackingHidden ? 1 : 0,
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

  setTrackingHidden(instanceId: string, hidden: boolean): InstanceRecord | null {
    const result = this.database.prepare("UPDATE managed_instances SET tracking_hidden = ? WHERE id = ?").run(hidden ? 1 : 0, instanceId)
    return result.changes === 0 ? null : this.getInstance(instanceId)
  }

  getPrimarySession(instanceId: string): PrimarySession | null {
    const row = this.database.prepare(`
      SELECT session_id, title, source, bound_at FROM instance_primary_sessions WHERE instance_id = ?
    `).get(instanceId) as unknown as PrimarySessionRow | undefined
    return row ? mapPrimarySession(row) : null
  }

  replacePrimarySession(instanceId: string, session: PrimarySession): void {
    this.database.prepare(`
      INSERT INTO instance_primary_sessions (instance_id, session_id, title, source, bound_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(instance_id) DO UPDATE SET
        session_id = excluded.session_id,
        title = excluded.title,
        source = excluded.source,
        bound_at = excluded.bound_at
    `).run(instanceId, session.sessionId, session.title, session.source, session.boundAt)
  }

  bindPrimarySessionIfAbsent(instanceId: string, session: PrimarySession): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO instance_primary_sessions (instance_id, session_id, title, source, bound_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(instanceId, session.sessionId, session.title, session.source, session.boundAt)
    return result.changes === 1
  }

  replacePrimarySessionIfUnchanged(instanceId: string, expected: PrimarySession, session: PrimarySession): boolean {
    // title 可由 metadata refresh 獨立更新；binding 的 CAS identity 只看 Session、source 與 boundAt。
    const result = this.database.prepare(`
      UPDATE instance_primary_sessions
      SET session_id = ?, title = ?, source = ?, bound_at = ?
      WHERE instance_id = ? AND session_id = ? AND source = ? AND bound_at = ?
    `).run(
      session.sessionId, session.title, session.source, session.boundAt,
      instanceId, expected.sessionId, expected.source, expected.boundAt,
    )
    return result.changes === 1
  }

  updatePrimarySessionTitle(instanceId: string, expected: PrimarySession, title: string): boolean {
    const result = this.database.prepare(`
      UPDATE instance_primary_sessions SET title = ?
      WHERE instance_id = ? AND session_id = ? AND source = ? AND bound_at = ?
    `).run(title, instanceId, expected.sessionId, expected.source, expected.boundAt)
    return result.changes === 1
  }

  getAllocationForInstance(instanceId: string): PortAllocation | null {
    const row = this.database.prepare("SELECT * FROM port_allocations WHERE instance_id = ?").get(instanceId) as unknown as PortAllocationRow | undefined
    return row ? mapAllocation(row) : null
  }

  finishStoppedAllocationRecheck(expected: InstanceRecord, allocation: PortAllocation | null, error: string | null, recoverMissingProcess = false): boolean {
    this.database.exec("BEGIN IMMEDIATE")
    try {
      // Probe 跨 await；instance mutex 不涵蓋其他 service／connection。必須核對原 record 與 allocation UUID，
      // 不可只按 instance_id 刪除，否則舊結果會釋放後來替換的 reservation 或覆寫新 identity。
      const unchanged = (expected.state === "stopped" || recoverMissingProcess) && (!allocation || allocation.instanceId === expected.id)
        && JSON.stringify(this.getInstance(expected.id)) === JSON.stringify(expected)
        && JSON.stringify(this.getAllocationForInstance(expected.id)) === JSON.stringify(allocation)
      if (unchanged) {
        this.saveInstance({ ...expected, error, ...(recoverMissingProcess ? {
          state: error === null ? "stopped" as const : "unreachable" as const,
          healthVersion: null,
          stoppedAt: error === null ? new Date().toISOString() : expected.stoppedAt,
        } : {}) })
        if (error === null && allocation) this.database.prepare("DELETE FROM port_allocations WHERE id = ? AND instance_id = ?").run(allocation.id, expected.id)
      }
      this.database.exec("COMMIT")
      return unchanged
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  deleteStoppedInstance(instanceId: string): "deleted" | "not-found" | "not-stopped" | "allocated" {
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const instance = this.getInstance(instanceId)
      if (!instance) {
        this.database.exec("COMMIT")
        return "not-found"
      }
      if (instance.state !== "stopped") {
        this.database.exec("COMMIT")
        return "not-stopped"
      }
      if (this.getAllocationForInstance(instanceId)) {
        this.database.exec("COMMIT")
        return "allocated"
      }
      this.database.prepare("DELETE FROM instance_primary_sessions WHERE instance_id = ?").run(instanceId)
      const deleted = this.database.prepare("DELETE FROM managed_instances WHERE id = ? AND state = 'stopped'").run(instanceId)
      if (deleted.changes !== 1) throw new Error("Stopped Instance deletion race detected.")
      this.database.exec("COMMIT")
      return "deleted"
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  getInstanceByInvocation(clientInvocationId: string): InstanceRecord | null {
    const row = this.database.prepare("SELECT * FROM managed_instances WHERE client_invocation_id = ?").get(clientInvocationId) as unknown as InstanceRow | undefined
    return row ? mapInstance(row) : null
  }

  allocationScopes(): Array<{ id: string; scope: string | null }> {
    // 舊 Worker 成功啟動已保存 epoch；沒有 scope/identity 的 reservation 不推測為可釋放。
    return this.database.prepare(`SELECT a.id, COALESCE(a.allocation_scope, i.creation_time_ticks) AS scope
      FROM port_allocations a LEFT JOIN managed_instances i ON i.id = a.instance_id`).all() as Array<{ id: string; scope: string | null }>
  }

  tryCreateAllocation(allocation: PortAllocation, obsoleteScopeIds: string[] = []): boolean {
    this.database.exec("BEGIN IMMEDIATE")
    try {
      // 僅人工啟動提供 fresh authority 之前讀取的舊 scope IDs；不觸碰歷史 Instance，也不釋放並行建立的 slot。
      if (allocation.allocationScope) for (const id of obsoleteScopeIds) {
        this.database.prepare("DELETE FROM port_allocations WHERE id = ?").run(id)
      }
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO port_allocations (
          id, kind, client_invocation_id, project_directory, port, created_at, expires_at, instance_id, allocation_scope
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        allocation.id, allocation.kind, allocation.clientInvocationId, allocation.projectDirectory,
        allocation.port, allocation.createdAt, allocation.expiresAt, allocation.instanceId, allocation.allocationScope ?? null,
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
    trackingHidden: row.tracking_hidden === 1,
  }
}

function mapAllocation(row: PortAllocationRow): PortAllocation {
  return {
    ...(row.allocation_scope === null ? {} : { allocationScope: row.allocation_scope }),
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

function mapPrimarySession(row: PrimarySessionRow): PrimarySession {
  return { sessionId: row.session_id, title: row.title, source: row.source, boundAt: row.bound_at }
}
