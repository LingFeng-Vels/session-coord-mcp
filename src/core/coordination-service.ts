import crypto from "node:crypto";
import path from "node:path";

import type { Database as BetterSqliteDatabase } from "better-sqlite3";

import { GitService } from "../git/git-service.js";
import type {
  ClaimMode,
  ServerConfig,
  SessionStatus,
  TaskStatus,
} from "../types.js";
import { parseJson, stringifyJson } from "../utils/json.js";
import {
  normalizeRelativePath,
  pathMatchesPattern,
  patternsOverlap,
} from "../utils/paths.js";

interface WorkspaceRow {
  id: string;
  root_path: string;
  repo_name: string;
  created_at: string;
}

interface SessionRow {
  id: string;
  workspace_id: string;
  agent_name: string;
  host_type: string;
  role: string | null;
  team_id: string | null;
  worktree_path: string;
  branch: string | null;
  status: SessionStatus;
  current_task_id: string | null;
  started_at: string;
  last_heartbeat_at: string;
  metadata_json: string | null;
}

interface TaskRow {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  owner_session_id: string | null;
  parent_task_id: string | null;
  depends_on_json: string;
  planned_paths_json: string;
  labels_json: string;
  acceptance_criteria: string | null;
  created_at: string;
  updated_at: string;
}

interface PathClaimRow {
  id: string;
  workspace_id: string;
  task_id: string | null;
  session_id: string;
  path_pattern: string;
  claim_mode: ClaimMode;
  reason: string | null;
  expires_at: string;
  created_at: string;
}

interface UpdateRow {
  id: string;
  workspace_id: string;
  session_id: string;
  task_id: string | null;
  kind: string;
  message: string;
  details_json: string | null;
  created_at: string;
}

interface DecisionRow {
  id: string;
  workspace_id: string;
  scope_key: string;
  title: string;
  summary: string;
  details: string | null;
  created_by_session_id: string;
  created_at: string;
}

interface TeamRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  created_at: string;
}

interface TeamMemberRow {
  id: string;
  workspace_id: string;
  team_id: string;
  session_id: string;
  member_role: string | null;
  joined_at: string;
}

interface CountRow {
  count: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function addMinutes(timestamp: string, minutes: number): string {
  const base = new Date(timestamp);
  base.setMinutes(base.getMinutes() + minutes);
  return base.toISOString();
}

function toTimestamp(timestamp: string): number {
  return new Date(timestamp).getTime();
}

function normalizePaths(paths: string[] | null | undefined, workspaceRoot: string): string[] {
  return [...new Set((paths ?? []).map((item) => normalizeRelativePath(item, workspaceRoot)))];
}

function claimModesConflict(existing: ClaimMode, incoming: ClaimMode): boolean {
  if (existing === "review-only" || incoming === "review-only") {
    return false;
  }

  return existing === "exclusive" || incoming === "exclusive";
}

export class CoordinationService {
  private readonly workspaceId: string;

  constructor(
    private readonly db: BetterSqliteDatabase,
    private readonly config: ServerConfig,
    private readonly gitService: GitService,
  ) {
    this.workspaceId = this.ensureWorkspace();
  }

  private ensureWorkspace(): string {
    const existing = this.db
      .prepare("SELECT * FROM workspaces WHERE root_path = ?")
      .get(this.config.workspaceRoot) as WorkspaceRow | undefined;

    if (existing) {
      return existing.id;
    }

    const id = crypto.randomUUID();
    const createdAt = nowIso();

    this.db
      .prepare(
        `
          INSERT INTO workspaces (id, root_path, repo_name, created_at)
          VALUES (?, ?, ?, ?)
        `,
      )
      .run(id, this.config.workspaceRoot, path.basename(this.config.workspaceRoot), createdAt);

    return id;
  }

  private reapStaleRecords(): void {
    const now = nowIso();
    const offlineThreshold = addMinutes(now, -this.config.offlineAfterMinutes);

    this.db.prepare("DELETE FROM path_claims WHERE expires_at <= ?").run(now);
    this.db
      .prepare(
        `
          UPDATE sessions
          SET status = 'offline'
          WHERE workspace_id = ?
            AND status != 'offline'
            AND last_heartbeat_at <= ?
        `,
      )
      .run(this.workspaceId, offlineThreshold);
  }

  private getWorkspaceSummary() {
    const activeSessions = Number(
      (
        this.db
          .prepare(
            `
              SELECT COUNT(*) AS count
              FROM sessions
              WHERE workspace_id = ? AND status != 'offline'
            `,
          )
          .get(this.workspaceId) as CountRow | undefined
      )?.count ?? 0,
    );
    const activeTasks = Number(
      (
        this.db
          .prepare(
            `
              SELECT COUNT(*) AS count
              FROM tasks
              WHERE workspace_id = ? AND status IN ('claimed', 'in_progress', 'blocked')
            `,
          )
          .get(this.workspaceId) as CountRow | undefined
      )?.count ?? 0,
    );
    const activeClaims = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS count FROM path_claims WHERE workspace_id = ?")
          .get(this.workspaceId) as CountRow | undefined
      )?.count ?? 0,
    );

    return {
      workspace_root: this.config.workspaceRoot,
      active_sessions: activeSessions,
      active_tasks: activeTasks,
      active_claims: activeClaims,
    };
  }

  private getSession(sessionId: string): SessionRow {
    const session = this.db
      .prepare("SELECT * FROM sessions WHERE workspace_id = ? AND id = ?")
      .get(this.workspaceId, sessionId) as SessionRow | undefined;

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return session;
  }

  private getTask(taskId: string): TaskRow {
    const task = this.db
      .prepare("SELECT * FROM tasks WHERE workspace_id = ? AND id = ?")
      .get(this.workspaceId, taskId) as TaskRow | undefined;

    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    return task;
  }

  private listActiveClaims(): PathClaimRow[] {
    return this.db
      .prepare("SELECT * FROM path_claims WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(this.workspaceId) as PathClaimRow[];
  }

  private serializeSession(row: SessionRow) {
    return {
      id: row.id,
      agent_name: row.agent_name,
      host_type: row.host_type,
      role: row.role,
      team_id: row.team_id,
      worktree_path: row.worktree_path,
      branch: row.branch,
      status: row.status,
      current_task_id: row.current_task_id,
      started_at: row.started_at,
      last_heartbeat_at: row.last_heartbeat_at,
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    };
  }

  private serializeTask(row: TaskRow) {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      owner_session_id: row.owner_session_id,
      parent_task_id: row.parent_task_id,
      depends_on: parseJson<string[]>(row.depends_on_json, []),
      planned_paths: parseJson<string[]>(row.planned_paths_json, []),
      labels: parseJson<string[]>(row.labels_json, []),
      acceptance_criteria: row.acceptance_criteria,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private serializeClaim(row: PathClaimRow) {
    return {
      id: row.id,
      task_id: row.task_id,
      session_id: row.session_id,
      path_pattern: row.path_pattern,
      claim_mode: row.claim_mode,
      reason: row.reason,
      expires_at: row.expires_at,
      created_at: row.created_at,
    };
  }

  private serializeUpdate(row: UpdateRow) {
    return {
      id: row.id,
      session_id: row.session_id,
      task_id: row.task_id,
      kind: row.kind,
      message: row.message,
      details: parseJson<Record<string, unknown>>(row.details_json, {}),
      created_at: row.created_at,
    };
  }

  private serializeDecision(row: DecisionRow) {
    return {
      id: row.id,
      scope_key: row.scope_key,
      title: row.title,
      summary: row.summary,
      details: row.details,
      created_by_session_id: row.created_by_session_id,
      created_at: row.created_at,
    };
  }

  private getTeam(teamId: string): TeamRow {
    const team = this.db
      .prepare("SELECT * FROM teams WHERE workspace_id = ? AND id = ?")
      .get(this.workspaceId, teamId) as TeamRow | undefined;

    if (!team) {
      throw new Error(`Team not found: ${teamId}`);
    }

    return team;
  }

  private listTeamsInternal(): TeamRow[] {
    return this.db
      .prepare("SELECT * FROM teams WHERE workspace_id = ? ORDER BY created_at ASC")
      .all(this.workspaceId) as TeamRow[];
  }

  private serializeTeam(row: TeamRow) {
    const memberCount = Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM team_members WHERE workspace_id = ? AND team_id = ?",
          )
          .get(this.workspaceId, row.id) as CountRow | undefined
      )?.count ?? 0,
    );

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      member_count: memberCount,
      created_at: row.created_at,
    };
  }

  registerSession(input: {
    agent_name: string;
    host_type: string;
    role?: string | null;
    workspace_root?: string | null;
    worktree_path?: string | null;
    branch?: string | null;
    metadata?: Record<string, unknown> | null;
  }) {
    this.reapStaleRecords();

    const sessionId = crypto.randomUUID();
    const startedAt = nowIso();
    const worktreePath = path.resolve(input.worktree_path ?? this.config.workspaceRoot);
    const branch = input.branch ?? this.gitService.getCurrentBranch(worktreePath);
    const warnings: string[] = [];

    if (input.workspace_root && path.resolve(input.workspace_root) !== this.config.workspaceRoot) {
      warnings.push(
        `Provided workspace_root (${path.resolve(input.workspace_root)}) does not match server workspace_root (${this.config.workspaceRoot}).`,
      );
    }

    this.db
      .prepare(
        `
          INSERT INTO sessions (
            id,
            workspace_id,
            agent_name,
            host_type,
            role,
            team_id,
            worktree_path,
            branch,
            status,
            current_task_id,
            started_at,
            last_heartbeat_at,
            metadata_json
          )
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'active', NULL, ?, ?, ?)
        `,
      )
      .run(
        sessionId,
        this.workspaceId,
        input.agent_name,
        input.host_type,
        input.role ?? null,
        worktreePath,
        branch ?? null,
        startedAt,
        startedAt,
        stringifyJson(input.metadata ?? {}),
      );

    return {
      session_id: sessionId,
      workspace_summary: this.getWorkspaceSummary(),
      warnings,
      suggested_next_actions: [
        "Run coord_onboarding_status to determine team selection.",
        "Run coord_list_tasks to inspect open work.",
        "Run coord_check_conflicts before editing shared paths.",
        "Create or claim a task before claiming paths.",
      ],
    };
  }

  heartbeat(input: {
    session_id: string;
    status?: SessionStatus | null;
    current_task_id?: string | null;
  }) {
    this.reapStaleRecords();
    this.getSession(input.session_id);

    const timestamp = nowIso();
    const extendedExpiry = addMinutes(timestamp, this.config.defaultTtlMinutes);
    const applyHeartbeat = this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE sessions
            SET last_heartbeat_at = ?,
                status = COALESCE(?, status),
                current_task_id = COALESCE(?, current_task_id)
            WHERE workspace_id = ? AND id = ?
          `,
        )
        .run(
          timestamp,
          input.status ?? null,
          input.current_task_id ?? null,
          this.workspaceId,
          input.session_id,
        );

      const extended = this.db
        .prepare(
          `
            UPDATE path_claims
            SET expires_at = ?
            WHERE workspace_id = ?
              AND session_id = ?
              AND expires_at > ?
              AND expires_at < ?
          `,
        )
        .run(extendedExpiry, this.workspaceId, input.session_id, timestamp, extendedExpiry);

      return extended.changes;
    });
    const claimsExtended = applyHeartbeat();

    return {
      ok: true,
      heartbeat_at: timestamp,
      claims_extended: claimsExtended,
      workspace_summary: this.getWorkspaceSummary(),
    };
  }

  listSessions() {
    this.reapStaleRecords();
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM sessions
          WHERE workspace_id = ?
          ORDER BY last_heartbeat_at DESC
        `,
      )
      .all(this.workspaceId) as SessionRow[];

    return {
      sessions: rows.map((row) => this.serializeSession(row)),
      workspace_summary: this.getWorkspaceSummary(),
    };
  }

  listTeams() {
    this.reapStaleRecords();

    return {
      teams: this.listTeamsInternal().map((row) => this.serializeTeam(row)),
    };
  }

  createTeam(input: { name: string; description?: string | null }) {
    this.reapStaleRecords();

    const teamId = crypto.randomUUID();
    const timestamp = nowIso();

    this.db
      .prepare(
        `
          INSERT INTO teams (id, workspace_id, name, description, created_at)
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(teamId, this.workspaceId, input.name, input.description ?? null, timestamp);

    return {
      team: this.serializeTeam(this.getTeam(teamId)),
    };
  }

  joinTeam(input: {
    session_id: string;
    team_id: string;
    member_role?: string | null;
  }) {
    this.reapStaleRecords();
    this.getSession(input.session_id);
    this.getTeam(input.team_id);

    this.db
      .prepare(
        `
          UPDATE sessions
          SET team_id = ?
          WHERE workspace_id = ? AND id = ?
        `,
      )
      .run(input.team_id, this.workspaceId, input.session_id);

    const existing = this.db
      .prepare(
        `
          SELECT *
          FROM team_members
          WHERE workspace_id = ? AND team_id = ? AND session_id = ?
        `,
      )
      .get(this.workspaceId, input.team_id, input.session_id) as TeamMemberRow | undefined;

    if (!existing) {
      this.db
        .prepare(
          `
            INSERT INTO team_members (
              id,
              workspace_id,
              team_id,
              session_id,
              member_role,
              joined_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          crypto.randomUUID(),
          this.workspaceId,
          input.team_id,
          input.session_id,
          input.member_role ?? null,
          nowIso(),
        );
    }

    return {
      team: this.serializeTeam(this.getTeam(input.team_id)),
      session: this.serializeSession(this.getSession(input.session_id)),
    };
  }

  onboardingStatus(input: { session_id: string }) {
    this.reapStaleRecords();
    const session = this.getSession(input.session_id);
    const teams = this.listTeamsInternal().map((row) => this.serializeTeam(row));

    if (session.team_id) {
      return {
        session_id: session.id,
        state: "already_joined",
        current_team_id: session.team_id,
        teams,
        prompt_for_user: "Current session already belongs to a team. You can continue coordination work.",
      };
    }

    if (teams.length === 0) {
      return {
        session_id: session.id,
        state: "no_team_found",
        teams,
        prompt_for_user:
          "No development team exists in this workspace. Ask the user whether to create a new team before continuing.",
        suggested_actions: ["coord_create_team", "coord_join_team"],
      };
    }

    if (teams.length === 1) {
      return {
        session_id: session.id,
        state: "single_team_available",
        teams,
        prompt_for_user:
          "One development team exists. Ask the user whether to join this team before continuing.",
        suggested_actions: ["coord_join_team"],
      };
    }

    return {
      session_id: session.id,
      state: "multiple_teams_available",
      teams,
      prompt_for_user:
        "Multiple development teams exist. Ask the user which team to join before continuing.",
      suggested_actions: ["coord_join_team"],
    };
  }

  createTask(input: {
    title: string;
    description?: string | null;
    priority?: number | null;
    planned_paths?: string[] | null;
    depends_on?: string[] | null;
    labels?: string[] | null;
    owner_session_id?: string | null;
    acceptance_criteria?: string | null;
  }) {
    this.reapStaleRecords();

    if (input.owner_session_id) {
      this.getSession(input.owner_session_id);
    }

    const taskId = crypto.randomUUID();
    const timestamp = nowIso();
    const plannedPaths = normalizePaths(input.planned_paths, this.config.workspaceRoot);

    this.db
      .prepare(
        `
          INSERT INTO tasks (
            id,
            workspace_id,
            title,
            description,
            status,
            priority,
            owner_session_id,
            parent_task_id,
            depends_on_json,
            planned_paths_json,
            labels_json,
            acceptance_criteria,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        taskId,
        this.workspaceId,
        input.title,
        input.description ?? null,
        input.owner_session_id ? "claimed" : "todo",
        input.priority ?? 0,
        input.owner_session_id ?? null,
        stringifyJson(input.depends_on ?? []),
        stringifyJson(plannedPaths),
        stringifyJson(input.labels ?? []),
        input.acceptance_criteria ?? null,
        timestamp,
        timestamp,
      );

    return {
      task: this.serializeTask(this.getTask(taskId)),
    };
  }

  listTasks(input: {
    status?: TaskStatus | null;
    owner_session_id?: string | null;
    label?: string | null;
    path?: string | null;
  }) {
    this.reapStaleRecords();

    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM tasks
          WHERE workspace_id = ?
          ORDER BY priority DESC, updated_at DESC
        `,
      )
      .all(this.workspaceId) as TaskRow[];

    const filtered = rows.filter((row) => {
      if (input.status && row.status !== input.status) {
        return false;
      }

      if (input.owner_session_id && row.owner_session_id !== input.owner_session_id) {
        return false;
      }

      if (input.label) {
        const labels = parseJson<string[]>(row.labels_json, []);
        if (!labels.includes(input.label)) {
          return false;
        }
      }

      if (input.path) {
        const normalizedPath = normalizeRelativePath(input.path, this.config.workspaceRoot);
        const plannedPaths = parseJson<string[]>(row.planned_paths_json, []);
        if (!plannedPaths.some((plannedPath) => patternsOverlap(plannedPath, normalizedPath))) {
          return false;
        }
      }

      return true;
    });

    return {
      tasks: filtered.map((row) => this.serializeTask(row)),
      total: filtered.length,
    };
  }

  claimTask(input: { task_id: string; session_id: string; force_reason?: string | null }) {
    this.reapStaleRecords();
    this.getSession(input.session_id);
    const task = this.getTask(input.task_id);

    if (task.owner_session_id && task.owner_session_id !== input.session_id && !input.force_reason) {
      throw new Error(
        `Task ${input.task_id} is already owned by session ${task.owner_session_id}. Provide force_reason to override.`,
      );
    }

    this.db
      .prepare(
        `
          UPDATE tasks
          SET owner_session_id = ?, status = 'claimed', updated_at = ?
          WHERE workspace_id = ? AND id = ?
        `,
      )
      .run(input.session_id, nowIso(), this.workspaceId, input.task_id);

    return {
      task: this.serializeTask(this.getTask(input.task_id)),
      forced: Boolean(input.force_reason),
    };
  }

  updateTask(input: {
    task_id: string;
    title?: string | null;
    description?: string | null;
    status?: TaskStatus | null;
    priority?: number | null;
    planned_paths?: string[] | null;
    depends_on?: string[] | null;
    labels?: string[] | null;
    owner_session_id?: string | null;
    acceptance_criteria?: string | null;
  }) {
    this.reapStaleRecords();
    const task = this.getTask(input.task_id);

    if (input.owner_session_id) {
      this.getSession(input.owner_session_id);
    }

    const nextPlannedPaths =
      input.planned_paths !== undefined
        ? normalizePaths(input.planned_paths, this.config.workspaceRoot)
        : parseJson<string[]>(task.planned_paths_json, []);
    const nextDependsOn =
      input.depends_on !== undefined
        ? input.depends_on ?? []
        : parseJson<string[]>(task.depends_on_json, []);
    const nextLabels =
      input.labels !== undefined ? input.labels ?? [] : parseJson<string[]>(task.labels_json, []);

    this.db
      .prepare(
        `
          UPDATE tasks
          SET title = ?,
              description = ?,
              status = ?,
              priority = ?,
              owner_session_id = ?,
              depends_on_json = ?,
              planned_paths_json = ?,
              labels_json = ?,
              acceptance_criteria = ?,
              updated_at = ?
          WHERE workspace_id = ? AND id = ?
        `,
      )
      .run(
        input.title ?? task.title,
        input.description ?? task.description,
        input.status ?? task.status,
        input.priority ?? task.priority,
        input.owner_session_id ?? task.owner_session_id,
        stringifyJson(nextDependsOn),
        stringifyJson(nextPlannedPaths),
        stringifyJson(nextLabels),
        input.acceptance_criteria ?? task.acceptance_criteria,
        nowIso(),
        this.workspaceId,
        input.task_id,
      );

    return {
      task: this.serializeTask(this.getTask(input.task_id)),
    };
  }

  completeTask(input: {
    task_id: string;
    session_id: string;
    release_claims?: boolean | null;
  }) {
    this.reapStaleRecords();
    this.getSession(input.session_id);
    const task = this.getTask(input.task_id);
    const timestamp = nowIso();
    const releaseClaims = input.release_claims ?? true;

    const complete = this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE tasks
            SET status = 'done', updated_at = ?
            WHERE workspace_id = ? AND id = ?
          `,
        )
        .run(timestamp, this.workspaceId, input.task_id);

      if (releaseClaims) {
        this.db
          .prepare(
            `
              DELETE FROM path_claims
              WHERE workspace_id = ? AND session_id = ? AND task_id = ?
            `,
          )
          .run(this.workspaceId, input.session_id, input.task_id);
      }

      this.db
        .prepare(
          `
            INSERT INTO updates (
              id,
              workspace_id,
              session_id,
              task_id,
              kind,
              message,
              details_json,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          crypto.randomUUID(),
          this.workspaceId,
          input.session_id,
          input.task_id,
          "progress",
          `Completed task: ${task.title}`,
          stringifyJson({
            event: "task_completed",
            release_claims: releaseClaims,
          }),
          timestamp,
        );
    });
    complete();

    return {
      task: this.serializeTask(this.getTask(input.task_id)),
    };
  }

  claimPaths(input: {
    session_id: string;
    task_id?: string | null;
    paths: string[];
    claim_mode: ClaimMode;
    ttl_minutes?: number | null;
    reason?: string | null;
    dry_run?: boolean | null;
  }) {
    this.reapStaleRecords();
    this.getSession(input.session_id);

    if (input.task_id) {
      this.getTask(input.task_id);
    }

    const normalizedPaths = normalizePaths(input.paths, this.config.workspaceRoot);
    const activeClaims = this.listActiveClaims();
    const conflicts = normalizedPaths.flatMap((requestedPath) =>
      activeClaims
        .filter((claim) => claim.session_id !== input.session_id)
        .filter((claim) => patternsOverlap(claim.path_pattern, requestedPath))
        .filter((claim) => claimModesConflict(claim.claim_mode, input.claim_mode))
        .map((claim) => ({
          requested_path: requestedPath,
          conflict: this.serializeClaim(claim),
        })),
    );

    if (conflicts.length > 0 || input.dry_run) {
      return {
        ok: conflicts.length === 0,
        dry_run: Boolean(input.dry_run),
        requested_paths: normalizedPaths,
        conflicts,
      };
    }

    const timestamp = nowIso();
    const expiresAt = addMinutes(
      timestamp,
      input.ttl_minutes ?? this.config.defaultTtlMinutes,
    );
    const insert = this.db.prepare(
      `
        INSERT INTO path_claims (
          id,
          workspace_id,
          task_id,
          session_id,
          path_pattern,
          claim_mode,
          reason,
          expires_at,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );
    const insertClaims = this.db.transaction((pathPatterns: string[]) => {
      for (const pathPattern of pathPatterns) {
        insert.run(
          crypto.randomUUID(),
          this.workspaceId,
          input.task_id ?? null,
          input.session_id,
          pathPattern,
          input.claim_mode,
          input.reason ?? null,
          expiresAt,
          timestamp,
        );
      }
    });
    insertClaims(normalizedPaths);

    return {
      ok: true,
      claim_mode: input.claim_mode,
      expires_at: expiresAt,
      claims: this.listActiveClaims()
        .filter((claim) => claim.session_id === input.session_id)
        .filter((claim) => normalizedPaths.includes(claim.path_pattern))
        .map((claim) => this.serializeClaim(claim)),
    };
  }

  releasePaths(input: { session_id: string; task_id?: string | null; paths?: string[] | null }) {
    this.reapStaleRecords();
    this.getSession(input.session_id);

    const normalizedPaths = input.paths
      ? normalizePaths(input.paths, this.config.workspaceRoot)
      : null;

    const claims = this.listActiveClaims().filter((claim) => claim.session_id === input.session_id);
    const releasable = claims.filter((claim) => {
      if (input.task_id && claim.task_id !== input.task_id) {
        return false;
      }

      if (normalizedPaths && !normalizedPaths.includes(claim.path_pattern)) {
        return false;
      }

      return true;
    });

    for (const claim of releasable) {
      this.db
        .prepare("DELETE FROM path_claims WHERE workspace_id = ? AND id = ?")
        .run(this.workspaceId, claim.id);
    }

    return {
      released_count: releasable.length,
      released_claims: releasable.map((claim) => this.serializeClaim(claim)),
    };
  }

  checkConflicts(input: { paths: string[]; session_id?: string | null }) {
    this.reapStaleRecords();

    const normalizedPaths = normalizePaths(input.paths, this.config.workspaceRoot);
    const claims = this.listActiveClaims();
    const tasks = this.db
      .prepare(
        `
          SELECT *
          FROM tasks
          WHERE workspace_id = ?
          ORDER BY updated_at DESC
        `,
      )
      .all(this.workspaceId) as TaskRow[];
    const decisions = this.db
      .prepare(
        `
          SELECT *
          FROM decisions
          WHERE workspace_id = ?
          ORDER BY created_at DESC
        `,
      )
      .all(this.workspaceId) as DecisionRow[];
    const sessions = this.db
      .prepare("SELECT * FROM sessions WHERE workspace_id = ?")
      .all(this.workspaceId) as SessionRow[];

    return {
      conflicts: normalizedPaths.map((requestedPath) => {
        const matches = claims
          .filter((claim) => (input.session_id ? claim.session_id !== input.session_id : true))
          .filter((claim) => patternsOverlap(claim.path_pattern, requestedPath))
          .map((claim) => this.serializeClaim(claim));
        const ownerIds = [...new Set(matches.map((match) => match.session_id))];
        const relatedTaskIds = new Set(
          matches.map((match) => match.task_id).filter((taskId): taskId is string => Boolean(taskId)),
        );

        const relatedTasks = tasks.filter((task) => {
          if (relatedTaskIds.has(task.id)) {
            return true;
          }

          const plannedPaths = parseJson<string[]>(task.planned_paths_json, []);
          return plannedPaths.some((plannedPath) => patternsOverlap(plannedPath, requestedPath));
        });
        const recentDecisions = decisions
          .filter((decision) => patternsOverlap(decision.scope_key, requestedPath))
          .slice(0, this.config.updatesLimit);

        return {
          requested_path: requestedPath,
          matches,
          owners: ownerIds.map((sessionId) => {
            const owner = sessions.find((session) => session.id === sessionId);
            return {
              session_id: sessionId,
              agent_name: owner?.agent_name ?? null,
              status: owner?.status ?? null,
            };
          }),
          related_tasks: relatedTasks.map((task) => this.serializeTask(task)),
          recent_decisions: recentDecisions.map((decision) => this.serializeDecision(decision)),
        };
      }),
    };
  }

  postUpdate(input: {
    session_id: string;
    task_id?: string | null;
    kind: "progress" | "blocker" | "decision" | "handoff" | "warning";
    message: string;
    details?: Record<string, unknown> | null;
  }) {
    this.reapStaleRecords();
    this.getSession(input.session_id);

    if (input.task_id) {
      this.getTask(input.task_id);
    }

    const id = crypto.randomUUID();
    const timestamp = nowIso();

    this.db
      .prepare(
        `
          INSERT INTO updates (
            id,
            workspace_id,
            session_id,
            task_id,
            kind,
            message,
            details_json,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        this.workspaceId,
        input.session_id,
        input.task_id ?? null,
        input.kind,
        input.message,
        stringifyJson(input.details ?? {}),
        timestamp,
      );

    const row = this.db
      .prepare("SELECT * FROM updates WHERE workspace_id = ? AND id = ?")
      .get(this.workspaceId, id) as UpdateRow;

    return {
      update: this.serializeUpdate(row),
    };
  }

  getUpdates(input: {
    since?: string | null;
    kind?: "progress" | "blocker" | "decision" | "handoff" | "warning" | null;
    session_id?: string | null;
    task_id?: string | null;
    path?: string | null;
    limit?: number | null;
  }) {
    this.reapStaleRecords();

    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM updates
          WHERE workspace_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(this.workspaceId, input.limit ?? this.config.updatesLimit) as UpdateRow[];

    const filtered = rows.filter((row) => {
      if (input.since && toTimestamp(row.created_at) < toTimestamp(input.since)) {
        return false;
      }

      if (input.kind && row.kind !== input.kind) {
        return false;
      }

      if (input.session_id && row.session_id !== input.session_id) {
        return false;
      }

      if (input.task_id && row.task_id !== input.task_id) {
        return false;
      }

      if (input.path) {
        const details = parseJson<Record<string, unknown>>(row.details_json, {});
        const paths = Array.isArray(details.paths) ? (details.paths as string[]) : [];
        if (!paths.some((item) => patternsOverlap(item, input.path!))) {
          return false;
        }
      }

      return true;
    });

    return {
      updates: filtered.map((row) => this.serializeUpdate(row)),
      total: filtered.length,
    };
  }

  recordDecision(input: {
    session_id: string;
    scope_key: string;
    title: string;
    summary: string;
    details?: string | null;
  }) {
    this.reapStaleRecords();
    this.getSession(input.session_id);

    const id = crypto.randomUUID();
    const timestamp = nowIso();

    this.db
      .prepare(
        `
          INSERT INTO decisions (
            id,
            workspace_id,
            scope_key,
            title,
            summary,
            details,
            created_by_session_id,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        this.workspaceId,
        input.scope_key,
        input.title,
        input.summary,
        input.details ?? null,
        input.session_id,
        timestamp,
      );

    const row = this.db
      .prepare("SELECT * FROM decisions WHERE workspace_id = ? AND id = ?")
      .get(this.workspaceId, id) as DecisionRow;

    return {
      decision: this.serializeDecision(row),
    };
  }

  searchContext(input: { query: string; limit?: number | null }) {
    this.reapStaleRecords();
    const query = input.query.trim().toLowerCase();
    const limit = input.limit ?? 10;

    const tasks = (this.db
      .prepare(
        `
          SELECT *
          FROM tasks
          WHERE workspace_id = ?
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(this.workspaceId, limit * 3) as TaskRow[])
      .map((row) => this.serializeTask(row))
      .filter((row) => JSON.stringify(row).toLowerCase().includes(query))
      .slice(0, limit);

    const updates = (this.db
      .prepare(
        `
          SELECT *
          FROM updates
          WHERE workspace_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(this.workspaceId, limit * 3) as UpdateRow[])
      .map((row) => this.serializeUpdate(row))
      .filter((row) => JSON.stringify(row).toLowerCase().includes(query))
      .slice(0, limit);

    const decisions = (this.db
      .prepare(
        `
          SELECT *
          FROM decisions
          WHERE workspace_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(this.workspaceId, limit * 3) as DecisionRow[])
      .map((row) => this.serializeDecision(row))
      .filter((row) => JSON.stringify(row).toLowerCase().includes(query))
      .slice(0, limit);

    const claims = this.listActiveClaims()
      .map((row) => this.serializeClaim(row))
      .filter((row) => JSON.stringify(row).toLowerCase().includes(query))
      .slice(0, limit);

    return {
      tasks,
      updates,
      decisions,
      claims,
    };
  }

  validateScope(input: { session_id: string; git_diff_base?: string | null }) {
    this.reapStaleRecords();
    const session = this.getSession(input.session_id);
    const changedPaths = [
      ...new Set(
        this.gitService
          .listChangedFiles(session.worktree_path, input.git_diff_base)
          .map((item) => normalizeRelativePath(item, session.worktree_path)),
      ),
    ];
    const claims = this.listActiveClaims().filter((claim) => claim.session_id === input.session_id);

    const matched = changedPaths.map((changedPath) => ({
      path: changedPath,
      matching_claims: claims
        .filter((claim) => pathMatchesPattern(changedPath, claim.path_pattern))
        .map((claim) => this.serializeClaim(claim)),
    }));

    const outOfScope = matched
      .filter((item) => item.matching_claims.length === 0)
      .map((item) => item.path);

    return {
      session_id: input.session_id,
      worktree_path: session.worktree_path,
      changed_paths: changedPaths,
      matched_paths: matched,
      out_of_scope_paths: outOfScope,
      warnings: outOfScope.length
        ? ["Some changed files are outside the session's claimed paths."]
        : [],
    };
  }
}
