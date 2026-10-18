# Changelog

## 0.1.1

- Heartbeat extends that session's unexpired path claims
- Completing a task writes a completion update
- Conflict checks include related tasks and recent decisions in the same scope
- Multi-path claims are inserted in one transaction
- Git scope checks throw on command failure and parse renamed or quoted porcelain paths
- Server version is read from `package.json`

## 0.1.0

- Initial open-source release
- Added local-first MCP server skeleton
- Added session, team, task, path-claim, update, and decision coordination flows
- Added one-click repository bootstrap for Claude Code and Codex
- Added onboarding flow for team creation or team selection
- Added GitHub-ready documentation, tests, and CI
