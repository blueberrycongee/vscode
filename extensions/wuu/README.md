# Wuu (built-in)

Wuu adds a task panel for worktree-first development inside VS Code.

## Current MVP

- Create isolated git worktrees per task
- List tasks in a dedicated **Wuu** activity bar view
- Attach multiple agent sessions to each task
- Show branch and changed-file count per task
- Track session status (`idle`, `busy`, `retry`) inspired by OpenCode session status flow
- Open any task worktree in a new VS Code window
- Start and stop per-session terminals in each task worktree
- Remove task metadata/worktree and cascade remove attached sessions

## Commands

- `Wuu: Create Task`
- `Wuu: Refresh Tasks`
- `Wuu: Open Worktree`
- `Wuu: Remove Task`
- `Wuu: Create Session`
- `Wuu: Start Session`
- `Wuu: Stop Session`
- `Wuu: Open Session Terminal`
- `Wuu: Remove Session`

## Configuration

- `wuu.worktreesRoot`: root directory for generated worktrees
  - default: `${workspaceFolder}/.wuu/worktrees`
  - variables: `${workspaceFolder}`, `${repoRoot}`
