---
name: codex-cli
description: Delegate coding, debugging, or independent code review tasks to local OpenAI Codex CLI via the agy-codex MCP server. Use when the user asks to have Codex write code, review changes, or collaborate across turns.
---

# Codex CLI Collaboration Skill

Use the `agy-codex` MCP server tools bundled with `agy-powertools` to orchestrate local Codex CLI runs cleanly without shell escaping or PATH issues.

## Available MCP Tools (`agy-codex`)

1. **`codex_doctor`**: Verify the local Codex CLI binary (auto-detects ChatGPT.app bundled binary, PATH, and custom `codexPath`), version, `~/.codex` auth status, and proxy inheritance.
2. **`codex_run`**: Start a new Codex task in a workspace directory (`cwd`), returning `sessionId`, final `message`, `filesChanged`, `usage`, and `durationMs`.
3. **`codex_resume`**: Continue an existing Codex session using `sessionId` for follow-up fixes or clarifications.
4. **`codex_review`**: Run native `codex exec review` (read-only) against uncommitted changes, a base branch, or a specific commit.

## Delegation Best Practices

- **Write concrete briefs**: Always specify the exact goal, target files, constraints, and acceptance tests in `prompt`.
- **Choose the right sandbox**:
  - Use `codex_review` or `sandbox: "read-only"` for analysis, debugging hypotheses, and code review.
  - Use `sandbox: "workspace-write"` (default) when Codex should directly implement edits.
  - Pass `worktree: true` if you want Codex to experiment in an isolated Git worktree without touching the active working tree.
- **Reuse sessions**: Save the `sessionId` returned by `codex_run` and use `codex_resume` for iterative follow-ups instead of starting from scratch.
- **Always verify**: After Codex modifies files, inspect `git diff` and run relevant unit tests yourself before reporting completion to the user.
