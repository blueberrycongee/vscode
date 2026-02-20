# Wuu (built-in)

Wuu adds a task panel for worktree-first development inside VS Code.

## Current MVP

- Create isolated git worktrees per task
- List tasks in a dedicated **Wuu** activity bar view
- Show branch and changed-file count per task
- Open any task worktree in a new VS Code window
- Remove task metadata or remove the worktree from git

## Commands

- `Wuu: Create Task`
- `Wuu: Refresh Tasks`
- `Wuu: Open Worktree`
- `Wuu: Remove Task`

## Configuration

- `wuu.worktreesRoot`: root directory for generated worktrees
  - default: `${workspaceFolder}/.wuu/worktrees`
  - variables: `${workspaceFolder}`, `${repoRoot}`
