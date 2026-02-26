# Wuu (built-in)

Wuu adds a panel workspace for worktree-first development inside VS Code.

## Current MVP

- Create isolated git worktrees per task
- List tasks in the bottom **Wuu** panel view
- Track exported patches in a dedicated **Patch Inbox** panel view
- Open a central **Wuu Dashboard** editor tab for task/session orchestration
- Attach multiple agent sessions to each task
- Show branch and changed-file count per task
- Track session status (`idle`, `busy`, `retry`) inspired by OpenCode session status flow
- Open any task worktree in a new VS Code window
- Start and stop per-session terminals in each task worktree
- Quick-reply to any running session (`Enter` sends) and open its terminal in editor area
- Export patch files from task worktrees into `.wuu/patches/`
- Preview and apply exported patches back to the primary workspace branch
- Handle patch apply conflicts via inbox actions (`Apply` retry, `Mark Applied`, `Requeue`, `Remove`)
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
- `Wuu: Open Session Terminal in Editor`
- `Wuu: Quick Reply to Session`
- `Wuu: Remove Session`
- `Wuu: Export Task Patch`
- `Wuu: Preview Patch`
- `Wuu: Apply Patch to Workspace`
- `Wuu: Requeue Patch`
- `Wuu: Mark Patch as Applied`
- `Wuu: Remove Patch`
- `Wuu: Focus Patch Inbox`
- `Wuu: Open Wuu Dashboard`

## Configuration

- `wuu.worktreesRoot`: root directory for generated worktrees
  - default: `${workspaceFolder}/.wuu/worktrees`
  - variables: `${workspaceFolder}`, `${repoRoot}`
