import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { CoordinationService } from "./core/coordination-service.js";
import { createDatabase } from "./db/database.js";
import { GitService } from "./git/git-service.js";
import { toTextResult } from "./mcp/result.js";
import type { ServerConfig } from "./types.js";
import { VERSION } from "./version.js";

export function createSessionCoordServer(config: ServerConfig) {
  const db = createDatabase(config.dbPath);
  const coordinationService = new CoordinationService(db, config, new GitService());

  const server = new McpServer({
    name: "session-coord-mcp",
    version: VERSION,
  });

  server.registerTool(
    "coord_register_session",
    {
      title: "Register Session",
      description: "Register a new coding session in the shared workspace.",
      inputSchema: {
        agent_name: z.string(),
        host_type: z.string(),
        role: z.string().optional(),
        workspace_root: z.string().optional(),
        worktree_path: z.string().optional(),
        branch: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => toTextResult(coordinationService.registerSession(args)),
  );

  server.registerTool(
    "coord_heartbeat",
    {
      title: "Heartbeat",
      description:
        "Refresh a session heartbeat, optionally update status or current task, and extend this session's unexpired path claims.",
      inputSchema: {
        session_id: z.string(),
        status: z.enum(["active", "idle", "blocked", "offline"]).optional(),
        current_task_id: z.string().optional(),
      },
    },
    async (args) => toTextResult(coordinationService.heartbeat(args)),
  );

  server.registerTool(
    "coord_list_sessions",
    {
      title: "List Sessions",
      description: "List all sessions in the current workspace.",
      inputSchema: {},
    },
    async () => toTextResult(coordinationService.listSessions()),
  );

  server.registerTool(
    "coord_list_teams",
    {
      title: "List Teams",
      description: "List development teams in the current workspace.",
      inputSchema: {},
    },
    async () => toTextResult(coordinationService.listTeams()),
  );

  server.registerTool(
    "coord_create_team",
    {
      title: "Create Team",
      description: "Create a development team for the current workspace.",
      inputSchema: {
        name: z.string(),
        description: z.string().optional(),
      },
    },
    async (args) => toTextResult(coordinationService.createTeam(args)),
  );

  server.registerTool(
    "coord_join_team",
    {
      title: "Join Team",
      description: "Join a development team with the current session.",
      inputSchema: {
        session_id: z.string(),
        team_id: z.string(),
        member_role: z.string().optional(),
      },
    },
    async (args) => toTextResult(coordinationService.joinTeam(args)),
  );

  server.registerTool(
    "coord_onboarding_status",
    {
      title: "Onboarding Status",
      description:
        "Check whether the current session needs to create or join a development team.",
      inputSchema: {
        session_id: z.string(),
      },
    },
    async (args) => toTextResult(coordinationService.onboardingStatus(args)),
  );

  server.registerTool(
    "coord_create_task",
    {
      title: "Create Task",
      description: "Create a new coordination task.",
      inputSchema: {
        title: z.string(),
        description: z.string().optional(),
        priority: z.number().int().optional(),
        planned_paths: z.array(z.string()).optional(),
        depends_on: z.array(z.string()).optional(),
        labels: z.array(z.string()).optional(),
        owner_session_id: z.string().optional(),
        acceptance_criteria: z.string().optional(),
      },
    },
    async (args) => toTextResult(coordinationService.createTask(args)),
  );

  server.registerTool(
    "coord_list_tasks",
    {
      title: "List Tasks",
      description: "List tasks with optional filters.",
      inputSchema: {
        status: z
          .enum(["todo", "claimed", "in_progress", "blocked", "done", "cancelled"])
          .optional(),
        owner_session_id: z.string().optional(),
        label: z.string().optional(),
        path: z.string().optional(),
      },
    },
    async (args) => toTextResult(coordinationService.listTasks(args)),
  );

  server.registerTool(
    "coord_claim_task",
    {
      title: "Claim Task",
      description: "Claim ownership of a task for a session.",
      inputSchema: {
        task_id: z.string(),
        session_id: z.string(),
        force_reason: z.string().optional(),
      },
    },
    async (args) => toTextResult(coordinationService.claimTask(args)),
  );

  server.registerTool(
    "coord_update_task",
    {
      title: "Update Task",
      description: "Update task metadata, owner, paths, dependencies, or status.",
      inputSchema: {
        task_id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        status: z
          .enum(["todo", "claimed", "in_progress", "blocked", "done", "cancelled"])
          .optional(),
        priority: z.number().int().optional(),
        planned_paths: z.array(z.string()).optional(),
        depends_on: z.array(z.string()).optional(),
        labels: z.array(z.string()).optional(),
        owner_session_id: z.string().optional(),
        acceptance_criteria: z.string().optional(),
      },
    },
    async (args) => toTextResult(coordinationService.updateTask(args)),
  );

  server.registerTool(
    "coord_complete_task",
    {
      title: "Complete Task",
      description:
        "Mark a task as done, optionally release its path claims, and write a completion update.",
      inputSchema: {
        task_id: z.string(),
        session_id: z.string(),
        release_claims: z.boolean().optional(),
      },
    },
    async (args) => toTextResult(coordinationService.completeTask(args)),
  );

  server.registerTool(
    "coord_claim_paths",
    {
      title: "Claim Paths",
      description: "Claim one or more repository paths for editing or coordination.",
      inputSchema: {
        session_id: z.string(),
        task_id: z.string().optional(),
        paths: z.array(z.string()).min(1),
        claim_mode: z.enum(["exclusive", "shared", "review-only"]),
        ttl_minutes: z.number().int().positive().optional(),
        reason: z.string().optional(),
        dry_run: z.boolean().optional(),
      },
    },
    async (args) => toTextResult(coordinationService.claimPaths(args)),
  );

  server.registerTool(
    "coord_release_paths",
    {
      title: "Release Paths",
      description: "Release selected path claims for a session.",
      inputSchema: {
        session_id: z.string(),
        task_id: z.string().optional(),
        paths: z.array(z.string()).optional(),
      },
    },
    async (args) => toTextResult(coordinationService.releasePaths(args)),
  );

  server.registerTool(
    "coord_check_conflicts",
    {
      title: "Check Conflicts",
      description:
        "Inspect candidate paths against active claims, related tasks, and recent decisions in the same scope.",
      inputSchema: {
        paths: z.array(z.string()).min(1),
        session_id: z.string().optional(),
      },
    },
    async (args) => toTextResult(coordinationService.checkConflicts(args)),
  );

  server.registerTool(
    "coord_post_update",
    {
      title: "Post Update",
      description: "Post a progress, blocker, warning, or handoff update.",
      inputSchema: {
        session_id: z.string(),
        task_id: z.string().optional(),
        kind: z.enum(["progress", "blocker", "decision", "handoff", "warning"]),
        message: z.string(),
        details: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => toTextResult(coordinationService.postUpdate(args)),
  );

  server.registerTool(
    "coord_get_updates",
    {
      title: "Get Updates",
      description: "Fetch recent updates with optional filters.",
      inputSchema: {
        since: z.string().optional(),
        kind: z.enum(["progress", "blocker", "decision", "handoff", "warning"]).optional(),
        session_id: z.string().optional(),
        task_id: z.string().optional(),
        path: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async (args) => toTextResult(coordinationService.getUpdates(args)),
  );

  server.registerTool(
    "coord_record_decision",
    {
      title: "Record Decision",
      description: "Record an architectural or interface decision for other sessions.",
      inputSchema: {
        session_id: z.string(),
        scope_key: z.string(),
        title: z.string(),
        summary: z.string(),
        details: z.string().optional(),
      },
    },
    async (args) => toTextResult(coordinationService.recordDecision(args)),
  );

  server.registerTool(
    "coord_search_context",
    {
      title: "Search Context",
      description: "Search tasks, claims, updates, and decisions by free text.",
      inputSchema: {
        query: z.string(),
        limit: z.number().int().positive().optional(),
      },
    },
    async (args) => toTextResult(coordinationService.searchContext(args)),
  );

  server.registerTool(
    "coord_validate_scope",
    {
      title: "Validate Scope",
      description: "Compare a session's current Git changes against its active path claims.",
      inputSchema: {
        session_id: z.string(),
        git_diff_base: z.string().optional(),
      },
    },
    async (args) => toTextResult(coordinationService.validateScope(args)),
  );

  return server;
}
