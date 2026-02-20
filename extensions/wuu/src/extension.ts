/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import {
	commands,
	EventEmitter,
	ExtensionContext,
	extensions,
	l10n,
	ThemeIcon,
	TreeDataProvider,
	TreeItem,
	TreeItemCollapsibleState,
	Uri,
	window,
	workspace,
	type Event,
	WorkspaceFolder,
} from 'vscode';
import { countChangedFiles, pathExists, resolveRepositoryRoot, runGit } from './git';
import { defaultBranchName, toSlug } from './naming';
import { emptyPatchSummary, WuuPatchRecord, WuuPatchStatus, WuuPatchStore, WuuPatchSummary } from './patchState';
import { WuuPtyInfo, WuuPtyManager } from './pty';
import { WuuSessionStatusInfo, WuuSessionStatusStore } from './sessionStatus';

const TASKS_STORAGE_KEY = 'wuu.tasks';
const SESSIONS_STORAGE_KEY = 'wuu.sessions';
const SESSION_STATUSES_STORAGE_KEY = 'wuu.sessionStatuses';

interface WuuTaskRecord {
	id: string;
	title: string;
	repoRoot: string;
	branch: string;
	worktreePath: string;
	createdAt: string;
}

interface WuuSessionRecord {
	id: string;
	taskId: string;
	name: string;
	agent: string;
	commandLine: string;
	createdAt: string;
}

type TaskHealth = 'ready' | 'missing' | 'error';

interface WuuTaskState {
	task: WuuTaskRecord;
	health: TaskHealth;
	changedFiles: number;
	patchSummary: WuuPatchSummary;
	error?: string;
}

interface WuuSessionState {
	session: WuuSessionRecord;
	task: WuuTaskRecord | undefined;
	status: WuuSessionStatusInfo;
	running: boolean;
	pty?: WuuPtyInfo;
}

interface WuuPatchState {
	patch: WuuPatchRecord;
	task: WuuTaskRecord | undefined;
}

interface GitRepositoryApi {
	rootUri: Uri;
	apply(patch: string, options?: { allowEmpty?: boolean; reverse?: boolean; threeWay?: boolean }): Promise<void>;
}

interface GitApi {
	repositories: GitRepositoryApi[];
}

interface GitExtensionApi {
	getAPI(version: 1): GitApi;
}

type WuuTreeItem = WuuTaskItem | WuuSessionItem;
type WuuPatchTreeItem = WuuPatchSectionItem | WuuPatchItem;

const PATCH_STATUS_ORDER: WuuPatchStatus[] = ['conflict', 'pending', 'applied', 'unsupported'];

class WuuTaskItem extends TreeItem {
	constructor(
		public readonly state: WuuTaskState,
		public readonly sessionCount: number,
	) {
		super(state.task.title, sessionCount > 0 ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None);
		this.contextValue = 'wuuTask';
		this.description = l10n.t('{0} · {1} files · {2} sessions · {3} patches', state.task.branch, state.changedFiles, sessionCount, state.patchSummary.pending);
		this.tooltip = toTaskTooltip(state, sessionCount, state.patchSummary);
		this.resourceUri = Uri.file(state.task.worktreePath);
		this.command = {
			command: 'wuu.openTask',
			title: l10n.t('Open Worktree'),
			arguments: [this],
		};

		if (state.health === 'error') {
			this.iconPath = new ThemeIcon('error');
		} else if (state.health === 'missing') {
			this.iconPath = new ThemeIcon('warning');
		} else if (state.patchSummary.conflict > 0) {
			this.iconPath = new ThemeIcon('warning');
		} else {
			this.iconPath = new ThemeIcon('git-branch');
		}
	}
}

class WuuSessionItem extends TreeItem {
	constructor(public readonly state: WuuSessionState) {
		super(state.session.name, TreeItemCollapsibleState.None);
		this.contextValue = toSessionContextValue(state);
		this.description = toSessionDescription(state);
		this.tooltip = toSessionTooltip(state);
		this.command = {
			command: 'wuu.openSessionTerminal',
			title: l10n.t('Open Session Terminal'),
			arguments: [this],
		};

		if (state.status.type === 'retry') {
			this.iconPath = new ThemeIcon('warning');
		} else if (state.running) {
			this.iconPath = new ThemeIcon('terminal');
		} else {
			this.iconPath = new ThemeIcon('debug-pause');
		}
	}
}

class WuuTreeProvider implements TreeDataProvider<WuuTreeItem> {
	private readonly onDidChangeTreeDataEmitter = new EventEmitter<WuuTreeItem | null>();
	readonly onDidChangeTreeData: Event<WuuTreeItem | null> = this.onDidChangeTreeDataEmitter.event;
	private taskStates: WuuTaskState[] = [];
	private sessionsByTask = new Map<string, WuuSessionState[]>();

	setData(taskStates: WuuTaskState[], sessionStates: WuuSessionState[]): void {
		this.taskStates = taskStates;
		const sessionsByTask = new Map<string, WuuSessionState[]>();
		for (const session of sessionStates) {
			const list = sessionsByTask.get(session.session.taskId) ?? [];
			list.push(session);
			sessionsByTask.set(session.session.taskId, list);
		}

		this.sessionsByTask = sessionsByTask;
		this.onDidChangeTreeDataEmitter.fire(null);
	}

	getTreeItem(element: WuuTreeItem): TreeItem {
		return element;
	}

	getParent(element: WuuTreeItem): WuuTreeItem | null {
		if (element instanceof WuuTaskItem) {
			return null;
		}

		const parentTask = this.taskStates.find(task => task.task.id === element.state.session.taskId);
		if (!parentTask) {
			return null;
		}

		const sessions = this.sessionsByTask.get(parentTask.task.id) ?? [];
		return new WuuTaskItem(parentTask, sessions.length);
	}

	getChildren(element?: WuuTreeItem): WuuTreeItem[] {
		if (!element) {
			return this.taskStates.map(task => new WuuTaskItem(task, (this.sessionsByTask.get(task.task.id) ?? []).length));
		}

		if (element instanceof WuuTaskItem) {
			const sessions = this.sessionsByTask.get(element.state.task.id) ?? [];
			return sessions
				.slice()
				.sort((a, b) => a.session.createdAt.localeCompare(b.session.createdAt))
				.map(session => new WuuSessionItem(session));
		}

		return [];
	}
}

class WuuPatchSectionItem extends TreeItem {
	constructor(
		public readonly status: WuuPatchStatus,
		public readonly count: number,
	) {
		super(l10n.t('{0} ({1})', patchStatusLabel(status), count), TreeItemCollapsibleState.Expanded);
		this.contextValue = 'wuuPatchSection';
		if (status === 'conflict') {
			this.iconPath = new ThemeIcon('warning');
		} else if (status === 'pending') {
			this.iconPath = new ThemeIcon('clock');
		} else if (status === 'applied') {
			this.iconPath = new ThemeIcon('pass-filled');
		} else {
			this.iconPath = new ThemeIcon('circle-slash');
		}
	}
}

class WuuPatchItem extends TreeItem {
	constructor(public readonly state: WuuPatchState) {
		super(state.task?.title ?? l10n.t('Missing task'), TreeItemCollapsibleState.None);
		this.contextValue = toPatchContextValue(state.patch.status);
		this.description = l10n.t('{0} · {1} files', state.patch.sourceBranch, state.patch.changedFiles);
		this.tooltip = toPatchTooltip(state);
		this.iconPath = patchIcon(state.patch.status);
		if (state.patch.patchPath) {
			this.command = {
				command: 'wuu.previewPatch',
				title: l10n.t('Preview Patch'),
				arguments: [this],
			};
		}
	}
}

class WuuPatchInboxProvider implements TreeDataProvider<WuuPatchTreeItem> {
	private readonly onDidChangeTreeDataEmitter = new EventEmitter<WuuPatchTreeItem | null>();
	readonly onDidChangeTreeData: Event<WuuPatchTreeItem | null> = this.onDidChangeTreeDataEmitter.event;
	private patchesByStatus = new Map<WuuPatchStatus, WuuPatchState[]>();

	setData(patches: WuuPatchState[]): void {
		const map = new Map<WuuPatchStatus, WuuPatchState[]>();
		for (const status of PATCH_STATUS_ORDER) {
			map.set(status, []);
		}

		for (const patch of patches) {
			const list = map.get(patch.patch.status) ?? [];
			list.push(patch);
			map.set(patch.patch.status, list);
		}

		for (const [status, entries] of map.entries()) {
			entries.sort((a, b) => b.patch.createdAt.localeCompare(a.patch.createdAt));
			map.set(status, entries);
		}

		this.patchesByStatus = map;
		this.onDidChangeTreeDataEmitter.fire(null);
	}

	getTreeItem(element: WuuPatchTreeItem): TreeItem {
		return element;
	}

	getParent(element: WuuPatchTreeItem): WuuPatchTreeItem | null {
		if (element instanceof WuuPatchSectionItem) {
			return null;
		}

		const count = (this.patchesByStatus.get(element.state.patch.status) ?? []).length;
		return new WuuPatchSectionItem(element.state.patch.status, count);
	}

	getChildren(element?: WuuPatchTreeItem): WuuPatchTreeItem[] {
		if (!element) {
			return PATCH_STATUS_ORDER
				.map(status => {
					const entries = this.patchesByStatus.get(status) ?? [];
					return entries.length > 0 ? new WuuPatchSectionItem(status, entries.length) : undefined;
				})
				.filter((entry): entry is WuuPatchSectionItem => Boolean(entry));
		}

		if (element instanceof WuuPatchSectionItem) {
			return (this.patchesByStatus.get(element.status) ?? []).map(entry => new WuuPatchItem(entry));
		}

		return [];
	}
}

class WuuStore {
	constructor(private readonly context: ExtensionContext) { }

	getTasks(): WuuTaskRecord[] {
		return this.context.workspaceState.get<WuuTaskRecord[]>(TASKS_STORAGE_KEY, []);
	}

	async saveTasks(tasks: WuuTaskRecord[]): Promise<void> {
		await this.context.workspaceState.update(TASKS_STORAGE_KEY, tasks);
	}

	async addTask(task: WuuTaskRecord): Promise<void> {
		const tasks = this.getTasks();
		tasks.push(task);
		await this.saveTasks(tasks);
	}

	async removeTask(taskId: string): Promise<void> {
		await this.saveTasks(this.getTasks().filter(task => task.id !== taskId));
	}

	getSessions(): WuuSessionRecord[] {
		return this.context.workspaceState.get<WuuSessionRecord[]>(SESSIONS_STORAGE_KEY, []);
	}

	async saveSessions(sessions: WuuSessionRecord[]): Promise<void> {
		await this.context.workspaceState.update(SESSIONS_STORAGE_KEY, sessions);
	}

	async addSession(session: WuuSessionRecord): Promise<void> {
		const sessions = this.getSessions();
		sessions.push(session);
		await this.saveSessions(sessions);
	}

	async removeSession(sessionId: string): Promise<void> {
		await this.saveSessions(this.getSessions().filter(session => session.id !== sessionId));
	}

	async removeSessionsForTask(taskId: string): Promise<void> {
		await this.saveSessions(this.getSessions().filter(session => session.taskId !== taskId));
	}

	getSessionStatuses(): Record<string, WuuSessionStatusInfo> {
		return this.context.workspaceState.get<Record<string, WuuSessionStatusInfo>>(SESSION_STATUSES_STORAGE_KEY, {});
	}

	async saveSessionStatuses(statuses: Record<string, WuuSessionStatusInfo>): Promise<void> {
		await this.context.workspaceState.update(SESSION_STATUSES_STORAGE_KEY, statuses);
	}
}

export function activate(context: ExtensionContext): void {
	const store = new WuuStore(context);
	const taskProvider = new WuuTreeProvider();
	const patchProvider = new WuuPatchInboxProvider();
	const ptyManager = new WuuPtyManager();
	const patchStore = new WuuPatchStore();
	const statusStore = new WuuSessionStatusStore(store.getSessionStatuses());

	context.subscriptions.push(
		ptyManager,
		window.createTreeView('wuu.tasks', { treeDataProvider: taskProvider }),
		window.createTreeView('wuu.patches', { treeDataProvider: patchProvider }),
		commands.registerCommand('wuu.createTask', async () => {
			await createTask(store);
			await refreshView(taskProvider, patchProvider, store, patchStore, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.refreshTasks', async () => {
			await refreshView(taskProvider, patchProvider, store, patchStore, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.openTask', async (item?: WuuTaskItem) => {
			const selected = item?.state.task ?? await pickTask(store);
			if (!selected) {
				return;
			}

			await commands.executeCommand('vscode.openFolder', Uri.file(selected.worktreePath), true);
		}),
		commands.registerCommand('wuu.removeTask', async (item?: WuuTaskItem) => {
			const selected = item?.state.task ?? await pickTask(store);
			if (!selected) {
				return;
			}

			await removeTask(selected, store, patchStore, statusStore, ptyManager);
			await refreshView(taskProvider, patchProvider, store, patchStore, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.createSession', async (item?: WuuTaskItem) => {
			const selectedTask = item?.state.task ?? await pickTask(store);
			if (!selectedTask) {
				return;
			}

			await createSession(selectedTask, store, statusStore, ptyManager);
			await refreshView(taskProvider, patchProvider, store, patchStore, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.startSession', async (item?: WuuSessionItem) => {
			const selectedSession = item?.state.session ?? await pickSession(store);
			if (!selectedSession) {
				return;
			}

			await startSession(selectedSession, store, statusStore, ptyManager);
			await refreshView(taskProvider, patchProvider, store, patchStore, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.stopSession', async (item?: WuuSessionItem) => {
			const selectedSession = item?.state.session ?? await pickSession(store);
			if (!selectedSession) {
				return;
			}

			await stopSession(selectedSession, store, statusStore, ptyManager);
			await refreshView(taskProvider, patchProvider, store, patchStore, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.openSessionTerminal', async (item?: WuuSessionItem) => {
			const selectedSession = item?.state.session ?? await pickSession(store);
			if (!selectedSession) {
				return;
			}

			await openSessionTerminal(selectedSession, store, statusStore, ptyManager);
			await refreshView(taskProvider, patchProvider, store, patchStore, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.removeSession', async (item?: WuuSessionItem) => {
			const selectedSession = item?.state.session ?? await pickSession(store);
			if (!selectedSession) {
				return;
			}

			await removeSession(selectedSession, store, statusStore, ptyManager);
			await refreshView(taskProvider, patchProvider, store, patchStore, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.exportTaskPatch', async (item?: WuuTaskItem) => {
			const task = item?.state.task ?? await pickTask(store);
			if (!task) {
				return;
			}

			await exportTaskPatch(task, patchStore);
			await refreshView(taskProvider, patchProvider, store, patchStore, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.previewPatch', async (item?: WuuTaskItem | WuuPatchItem) => {
			const patch = await resolvePatchSelection(item, store, patchStore, undefined);
			if (!patch) {
				return;
			}

			await previewPatch(patch);
		}),
		commands.registerCommand('wuu.applyPatch', async (item?: WuuTaskItem | WuuPatchItem) => {
			const patch = await resolvePatchSelection(item, store, patchStore, ['pending', 'conflict']);
			if (!patch) {
				return;
			}

			await applyPatchToWorkspace(patch, patchStore);
			await refreshView(taskProvider, patchProvider, store, patchStore, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.requeuePatch', async (item?: WuuPatchItem) => {
			const patch = item?.state.patch ?? await pickPatch(store, patchStore, { statuses: ['conflict', 'applied'] });
			if (!patch) {
				return;
			}

			await requeuePatch(patch, patchStore);
			await refreshView(taskProvider, patchProvider, store, patchStore, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.markPatchApplied', async (item?: WuuPatchItem) => {
			const patch = item?.state.patch ?? await pickPatch(store, patchStore, { statuses: ['conflict', 'pending'] });
			if (!patch) {
				return;
			}

			await markPatchApplied(patch, patchStore);
			await refreshView(taskProvider, patchProvider, store, patchStore, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.removePatch', async (item?: WuuPatchItem) => {
			const patch = item?.state.patch ?? await pickPatch(store, patchStore);
			if (!patch) {
				return;
			}

			await removePatchRecord(patch, patchStore);
			await refreshView(taskProvider, patchProvider, store, patchStore, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.focusPatchInbox', async () => {
			await commands.executeCommand('wuu.patches.focus');
		}),
		ptyManager.onDidExit(async event => {
			await setSessionStatus(event.sessionId, { type: 'idle' }, statusStore, store);
			await refreshView(taskProvider, patchProvider, store, patchStore, statusStore, ptyManager);
		}),
	);

	void initializeView(taskProvider, patchProvider, store, patchStore, statusStore, ptyManager);
}

export function deactivate(): void {
}

async function initializeView(
	taskProvider: WuuTreeProvider,
	patchProvider: WuuPatchInboxProvider,
	store: WuuStore,
	patchStore: WuuPatchStore,
	statusStore: WuuSessionStatusStore,
	ptyManager: WuuPtyManager,
): Promise<void> {
	for (const [sessionId, status] of Object.entries(statusStore.list())) {
		if (status.type === 'busy') {
			statusStore.set(sessionId, { type: 'idle' });
		}
	}
	await store.saveSessionStatuses(statusStore.list());
	await refreshView(taskProvider, patchProvider, store, patchStore, statusStore, ptyManager);
}

async function createTask(store: WuuStore): Promise<void> {
	const workspaceFolder = getPrimaryWorkspaceFolder();
	if (!workspaceFolder) {
		window.showErrorMessage(l10n.t('Open a workspace folder to create a Wuu task.'));
		return;
	}

	let repoRoot: string;
	try {
		repoRoot = await resolveRepositoryRoot(workspaceFolder.uri.fsPath);
	} catch (error) {
		window.showErrorMessage(l10n.t('The selected workspace folder is not a git repository: {0}', asErrorMessage(error)));
		return;
	}

	const title = await window.showInputBox({
		title: l10n.t('Create Wuu Task'),
		prompt: l10n.t('Task name'),
		placeHolder: l10n.t('Example: fix-login-timeout'),
		ignoreFocusOut: true,
		validateInput: input => input.trim().length === 0 ? l10n.t('Task name is required.') : undefined,
	});
	if (!title) {
		return;
	}

	const branch = await window.showInputBox({
		title: l10n.t('Create Wuu Task'),
		prompt: l10n.t('Branch name'),
		value: defaultBranchName(title),
		ignoreFocusOut: true,
		validateInput: input => input.trim().length === 0 ? l10n.t('Branch name is required.') : undefined,
	});
	if (!branch) {
		return;
	}

	const worktreesRoot = resolveWorktreesRoot(workspaceFolder, repoRoot);
	await fs.mkdir(worktreesRoot, { recursive: true });

	const worktreePath = path.join(worktreesRoot, toSlug(title));
	if (await pathExists(worktreePath)) {
		window.showErrorMessage(l10n.t('Worktree path already exists: {0}', worktreePath));
		return;
	}

	try {
		await runGit(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], repoRoot);
	} catch (error) {
		window.showErrorMessage(l10n.t('Failed to create worktree: {0}', asErrorMessage(error)));
		return;
	}

	const task: WuuTaskRecord = {
		id: createTaskId(),
		title,
		repoRoot,
		branch,
		worktreePath,
		createdAt: new Date().toISOString(),
	};

	await store.addTask(task);

	const openAction = l10n.t('Open Worktree');
	const selection = await window.showInformationMessage(
		l10n.t('Task "{0}" created in {1}.', title, worktreePath),
		openAction,
	);

	if (selection === openAction) {
		await commands.executeCommand('vscode.openFolder', Uri.file(worktreePath), true);
	}
}

async function createSession(
	task: WuuTaskRecord,
	store: WuuStore,
	statusStore: WuuSessionStatusStore,
	ptyManager: WuuPtyManager,
): Promise<void> {
	const selectedAgent = await window.showQuickPick([
		{ label: 'codex', description: 'OpenAI Codex', defaultCommand: 'codex' },
		{ label: 'opencode', description: 'OpenCode CLI', defaultCommand: 'opencode' },
		{ label: 'claude-code', description: 'Claude Code CLI', defaultCommand: 'claude' },
		{ label: 'oh-my-opencode', description: 'oh-my-opencode orchestrator', defaultCommand: 'omo' },
		{ label: 'custom', description: 'Custom agent command', defaultCommand: '' },
	], {
		title: l10n.t('Select agent for task "{0}"', task.title),
		ignoreFocusOut: true,
	});
	if (!selectedAgent) {
		return;
	}

	const taskSessions = store.getSessions().filter(session => session.taskId === task.id);
	const defaultName = `${selectedAgent.label}-${taskSessions.length + 1}`;
	const sessionName = await window.showInputBox({
		title: l10n.t('Create Wuu Session'),
		prompt: l10n.t('Session name'),
		value: defaultName,
		ignoreFocusOut: true,
		validateInput: input => input.trim().length === 0 ? l10n.t('Session name is required.') : undefined,
	});
	if (!sessionName) {
		return;
	}

	const commandLine = await window.showInputBox({
		title: l10n.t('Create Wuu Session'),
		prompt: l10n.t('Agent command line'),
		value: selectedAgent.defaultCommand,
		ignoreFocusOut: true,
		validateInput: input => input.trim().length === 0 ? l10n.t('Command line is required.') : undefined,
	});
	if (!commandLine) {
		return;
	}

	const session: WuuSessionRecord = {
		id: createSessionId(),
		taskId: task.id,
		name: sessionName,
		agent: selectedAgent.label,
		commandLine,
		createdAt: new Date().toISOString(),
	};

	await store.addSession(session);
	await setSessionStatus(session.id, { type: 'idle' }, statusStore, store);

	const startAction = l10n.t('Start Session');
	const selection = await window.showInformationMessage(
		l10n.t('Session "{0}" created for task "{1}".', session.name, task.title),
		startAction,
	);

	if (selection === startAction) {
		await startSession(session, store, statusStore, ptyManager);
	}
}

async function startSession(
	session: WuuSessionRecord,
	store: WuuStore,
	statusStore: WuuSessionStatusStore,
	ptyManager: WuuPtyManager,
): Promise<void> {
	const task = store.getTasks().find(item => item.id === session.taskId);
	if (!task) {
		window.showErrorMessage(l10n.t('Task for this session no longer exists.'));
		return;
	}

	if (!await pathExists(task.worktreePath)) {
		window.showErrorMessage(l10n.t('Worktree path no longer exists: {0}', task.worktreePath));
		return;
	}

	try {
		ptyManager.start(
			session.id,
			`${session.name} (${session.agent})`,
			session.commandLine,
			task.worktreePath,
		);
		await setSessionStatus(session.id, { type: 'busy' }, statusStore, store);
	} catch (error) {
		const currentStatus = statusStore.get(session.id);
		const attempt = currentStatus.type === 'retry' ? currentStatus.attempt + 1 : 1;
		const retryStatus: WuuSessionStatusInfo = {
			type: 'retry',
			attempt,
			message: asErrorMessage(error),
			next: Date.now() + 15_000,
		};
		await setSessionStatus(session.id, retryStatus, statusStore, store);
		window.showErrorMessage(l10n.t('Failed to start session: {0}', asErrorMessage(error)));
	}
}

async function stopSession(
	session: WuuSessionRecord,
	store: WuuStore,
	statusStore: WuuSessionStatusStore,
	ptyManager: WuuPtyManager,
): Promise<void> {
	ptyManager.stop(session.id);
	await setSessionStatus(session.id, { type: 'idle' }, statusStore, store);
}

async function openSessionTerminal(
	session: WuuSessionRecord,
	store: WuuStore,
	statusStore: WuuSessionStatusStore,
	ptyManager: WuuPtyManager,
): Promise<void> {
	if (ptyManager.reveal(session.id)) {
		return;
	}

	const startAction = l10n.t('Start Session');
	const selection = await window.showInformationMessage(
		l10n.t('Session "{0}" is not running.', session.name),
		startAction,
	);

	if (selection === startAction) {
		await startSession(session, store, statusStore, ptyManager);
	}
}

async function removeSession(
	session: WuuSessionRecord,
	store: WuuStore,
	statusStore: WuuSessionStatusStore,
	ptyManager: WuuPtyManager,
): Promise<void> {
	const removeLabel = l10n.t('Remove Session');
	const picked = await window.showWarningMessage(
		l10n.t('Remove session "{0}"?', session.name),
		{ modal: true },
		removeLabel,
	);

	if (picked !== removeLabel) {
		return;
	}

	ptyManager.stop(session.id);
	statusStore.remove(session.id);
	await store.removeSession(session.id);
	await store.saveSessionStatuses(statusStore.list());
}

async function exportTaskPatch(task: WuuTaskRecord, patchStore: WuuPatchStore): Promise<void> {
	if (!await pathExists(task.worktreePath)) {
		window.showErrorMessage(l10n.t('Worktree path no longer exists: {0}', task.worktreePath));
		return;
	}
	const changedFiles = await countChangedFiles(task.worktreePath);
	if (changedFiles === 0) {
		window.showInformationMessage(l10n.t('No changes were found in this task worktree.'));
		return;
	}

	const trackedNumstat = await runGit(['diff', '--numstat', '--no-renames', 'HEAD', '--', '.'], task.worktreePath);
	const trackedTextFiles = new Set<string>();
	const unsupportedFiles = new Set<string>();

	for (const line of trackedNumstat.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
		const parsed = parseNumstatLine(line);
		if (!parsed) {
			continue;
		}

		if (parsed.additions === '-' || parsed.deletions === '-') {
			unsupportedFiles.add(parsed.filePath);
		} else {
			trackedTextFiles.add(parsed.filePath);
		}
	}

	const untrackedFiles = (await runGit(['ls-files', '--others', '--exclude-standard', '--', '.'], task.worktreePath)).stdout
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean);
	const untrackedTextFiles: string[] = [];

	for (const relativePath of untrackedFiles) {
		const fullPath = path.join(task.worktreePath, relativePath);
		if (await isLikelyBinaryFile(fullPath)) {
			unsupportedFiles.add(relativePath);
		} else {
			untrackedTextFiles.push(relativePath);
		}
	}

	const patchParts: string[] = [];
	if (trackedTextFiles.size > 0) {
		const trackedPatch = await runGit(
			['diff', '--binary', '--no-ext-diff', '--no-renames', 'HEAD', '--', ...trackedTextFiles],
			task.worktreePath,
		);
		if (trackedPatch.stdout.trim()) {
			patchParts.push(trackedPatch.stdout.trimEnd());
		}
	}

	for (const relativePath of untrackedTextFiles) {
		try {
			const diff = await runGit(
				['diff', '--no-ext-diff', '--no-index', '--', '/dev/null', relativePath],
				task.worktreePath,
				{ allowedExitCodes: [0, 1] },
			);
			if (diff.stdout.trim()) {
				patchParts.push(diff.stdout.trimEnd());
			}
		} catch {
			unsupportedFiles.add(relativePath);
		}
	}

	const patchText = patchParts.join('\n\n');
	if (!patchText && unsupportedFiles.size === 0) {
		window.showInformationMessage(l10n.t('No exportable patch was found for this task.'));
		return;
	}

	let status: WuuPatchStatus = 'pending';
	let patchPath = '';
	if (!patchText) {
		status = 'unsupported';
	} else {
		const patchDirectory = await patchStore.ensurePatchDirectory(task.repoRoot, task.id);
		const patchFilename = `${Date.now()}-${toSlug(task.title)}.patch`;
		patchPath = path.join(patchDirectory, patchFilename);
		await fs.writeFile(patchPath, patchText + '\n', 'utf8');
	}

	const patchRecord: WuuPatchRecord = {
		id: createPatchId(),
		taskId: task.id,
		repoRoot: task.repoRoot,
		sourceBranch: task.branch,
		patchPath,
		status,
		createdAt: new Date().toISOString(),
		changedFiles,
		unsupportedFiles: [...unsupportedFiles].sort(),
	};

	await patchStore.add(task.repoRoot, patchRecord);

	if (status === 'unsupported') {
		window.showWarningMessage(l10n.t('Patch export skipped unsupported files. No patch was generated.'));
		return;
	}

	const previewAction = l10n.t('Preview Patch');
	const applyAction = l10n.t('Apply Patch');
	const message = unsupportedFiles.size > 0
		? l10n.t('Patch exported with {0} unsupported file(s).', unsupportedFiles.size)
		: l10n.t('Patch exported successfully.');
	const selection = await window.showInformationMessage(message, previewAction, applyAction);
	if (selection === previewAction) {
		await previewPatch(patchRecord);
	} else if (selection === applyAction) {
		await applyPatchToWorkspace(patchRecord, patchStore);
	}
}

async function previewPatch(patch: WuuPatchRecord): Promise<void> {
	if (!patch.patchPath) {
		window.showInformationMessage(l10n.t('This patch has no text payload to preview.'));
		return;
	}
	if (!await pathExists(patch.patchPath)) {
		window.showErrorMessage(l10n.t('Patch file no longer exists: {0}', patch.patchPath));
		return;
	}

	const document = await workspace.openTextDocument(Uri.file(patch.patchPath));
	await window.showTextDocument(document, { preview: false, preserveFocus: false });
}

async function applyPatchToWorkspace(patch: WuuPatchRecord, patchStore: WuuPatchStore): Promise<void> {
	if (!patch.patchPath) {
		window.showErrorMessage(l10n.t('This patch cannot be applied because no patch file was generated.'));
		return;
	}
	if (!await pathExists(patch.patchPath)) {
		window.showErrorMessage(l10n.t('Patch file no longer exists: {0}', patch.patchPath));
		return;
	}

	const workspaceFolder = getPrimaryWorkspaceFolder();
	if (!workspaceFolder) {
		window.showErrorMessage(l10n.t('Open the target workspace before applying a patch.'));
		return;
	}

	let currentRepoRoot: string;
	try {
		currentRepoRoot = await resolveRepositoryRoot(workspaceFolder.uri.fsPath);
	} catch (error) {
		window.showErrorMessage(l10n.t('The current workspace is not a git repository: {0}', asErrorMessage(error)));
		return;
	}

	if (currentRepoRoot !== patch.repoRoot) {
		window.showErrorMessage(l10n.t('Patch repository mismatch. Open the primary repository workspace to apply this patch.'));
		return;
	}

	try {
		const gitRepository = await getGitRepositoryApi(currentRepoRoot);
		if (gitRepository) {
			await gitRepository.apply(patch.patchPath, { threeWay: true });
		} else {
			await runGit(['apply', '--3way', patch.patchPath], currentRepoRoot);
		}

		const appliedBranch = await getCurrentBranch(currentRepoRoot);
		await patchStore.update(patch.repoRoot, patch.id, current => ({
			...current,
			status: 'applied',
			appliedAt: new Date().toISOString(),
			appliedBranch,
			error: undefined,
		}));
		window.showInformationMessage(l10n.t('Patch applied successfully on branch {0}.', appliedBranch));
	} catch (error) {
		const message = asErrorMessage(error);
		await patchStore.update(patch.repoRoot, patch.id, current => ({
			...current,
			status: 'conflict',
			error: message,
		}));
		const openPatchInboxAction = l10n.t('Open Patch Inbox');
		const openScmAction = l10n.t('Open Source Control');
		const previewAction = l10n.t('Preview Patch');
		const selection = await window.showErrorMessage(
			l10n.t('Patch apply failed and was moved to conflict: {0}', message),
			openPatchInboxAction,
			openScmAction,
			previewAction,
		);
		if (selection === openPatchInboxAction) {
			await commands.executeCommand('wuu.patches.focus');
		} else if (selection === openScmAction) {
			await commands.executeCommand('workbench.view.scm');
		} else if (selection === previewAction) {
			await previewPatch(patch);
		}
	}
}

async function markPatchApplied(patch: WuuPatchRecord, patchStore: WuuPatchStore): Promise<void> {
	if (patch.status === 'unsupported') {
		window.showErrorMessage(l10n.t('Unsupported patch entries cannot be marked as applied.'));
		return;
	}

	const workspaceFolder = getPrimaryWorkspaceFolder();
	if (!workspaceFolder) {
		window.showErrorMessage(l10n.t('Open the target workspace before updating patch status.'));
		return;
	}

	let currentRepoRoot: string;
	try {
		currentRepoRoot = await resolveRepositoryRoot(workspaceFolder.uri.fsPath);
	} catch (error) {
		window.showErrorMessage(l10n.t('The current workspace is not a git repository: {0}', asErrorMessage(error)));
		return;
	}

	if (currentRepoRoot !== patch.repoRoot) {
		window.showErrorMessage(l10n.t('Patch repository mismatch. Open the primary repository workspace first.'));
		return;
	}

	const unresolved = (await runGit(['diff', '--name-only', '--diff-filter=U'], currentRepoRoot)).stdout
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean);
	if (unresolved.length > 0) {
		const openScmAction = l10n.t('Open Source Control');
		const selection = await window.showWarningMessage(
			l10n.t('Resolve merge conflicts before marking as applied. Unmerged files: {0}', unresolved.length),
			openScmAction,
		);
		if (selection === openScmAction) {
			await commands.executeCommand('workbench.view.scm');
		}
		return;
	}

	const appliedBranch = await getCurrentBranch(currentRepoRoot);
	await patchStore.update(patch.repoRoot, patch.id, current => ({
		...current,
		status: 'applied',
		appliedAt: new Date().toISOString(),
		appliedBranch,
		error: undefined,
	}));
	window.showInformationMessage(l10n.t('Patch marked as applied on branch {0}.', appliedBranch));
}

async function requeuePatch(patch: WuuPatchRecord, patchStore: WuuPatchStore): Promise<void> {
	if (patch.status === 'unsupported') {
		window.showErrorMessage(l10n.t('Unsupported patch entries cannot be requeued.'));
		return;
	}

	await patchStore.update(patch.repoRoot, patch.id, current => ({
		...current,
		status: 'pending',
		error: undefined,
	}));
	window.showInformationMessage(l10n.t('Patch moved back to pending.'));
}

async function removePatchRecord(patch: WuuPatchRecord, patchStore: WuuPatchStore): Promise<void> {
	const removeLabel = l10n.t('Remove Patch');
	const selection = await window.showWarningMessage(
		l10n.t('Remove this patch record?'),
		{ modal: true },
		removeLabel,
	);
	if (selection !== removeLabel) {
		return;
	}

	const removed = await patchStore.remove(patch.repoRoot, patch.id);
	if (!removed) {
		window.showWarningMessage(l10n.t('Patch record was not found.'));
	}
}

async function resolvePatchSelection(
	item: WuuTaskItem | WuuPatchItem | undefined,
	store: WuuStore,
	patchStore: WuuPatchStore,
	statuses?: WuuPatchStatus[],
): Promise<WuuPatchRecord | undefined> {
	if (item instanceof WuuPatchItem) {
		if (statuses && !statuses.includes(item.state.patch.status)) {
			window.showInformationMessage(l10n.t('This patch is not eligible for the selected action.'));
			return undefined;
		}
		return item.state.patch;
	}

	return await pickPatch(store, patchStore, {
		taskId: item?.state.task.id,
		statuses,
	});
}

async function pickPatch(
	store: WuuStore,
	patchStore: WuuPatchStore,
	options?: { taskId?: string; statuses?: WuuPatchStatus[] },
): Promise<WuuPatchRecord | undefined> {
	const tasks = store.getTasks();
	if (tasks.length === 0) {
		window.showInformationMessage(l10n.t('No tasks available.'));
		return;
	}

	const taskById = new Map(tasks.map(task => [task.id, task]));
	const patches = (await listPatchesForKnownTasks(store, patchStore))
		.filter(patch => !options?.taskId || patch.taskId === options.taskId)
		.filter(patch => !options?.statuses || options.statuses.includes(patch.status));

	if (patches.length === 0) {
		window.showInformationMessage(l10n.t('No patches available for this selection.'));
		return;
	}

	const picked = await window.showQuickPick(patches.map(patch => ({
		label: patchLabel(patch),
		description: taskById.get(patch.taskId)?.title ?? l10n.t('Missing task'),
		detail: patchDetails(patch),
		patch,
	})), {
		title: l10n.t('Select Wuu Patch'),
		ignoreFocusOut: true,
	});

	return picked?.patch;
}

async function listPatchesForKnownTasks(store: WuuStore, patchStore: WuuPatchStore): Promise<WuuPatchRecord[]> {
	const tasks = store.getTasks();
	const taskIds = new Set(tasks.map(task => task.id));
	const repoRoots = [...new Set(tasks.map(task => task.repoRoot))];
	const patchLists = await Promise.all(repoRoots.map(repoRoot => patchStore.list(repoRoot)));
	return patchLists
		.flat()
		.filter(patch => taskIds.has(patch.taskId))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function refreshView(
	taskProvider: WuuTreeProvider,
	patchProvider: WuuPatchInboxProvider,
	store: WuuStore,
	patchStore: WuuPatchStore,
	statusStore: WuuSessionStatusStore,
	ptyManager: WuuPtyManager,
): Promise<void> {
	const tasks = store.getTasks();
	const patchSummaryByTask = await patchStore.summarizeByTask(tasks.map(task => task.repoRoot));
	const taskStates = await Promise.all(tasks.map(task => inspectTask(task, patchSummaryByTask.get(task.id) ?? emptyPatchSummary())));
	const taskMap = new Map(taskStates.map(taskState => [taskState.task.id, taskState.task]));
	const sessionStates = store.getSessions().map(session => {
		const running = ptyManager.isRunning(session.id);
		const status = running ? { type: 'busy' } satisfies WuuSessionStatusInfo : statusStore.get(session.id);
		return {
			session,
			task: taskMap.get(session.taskId),
			status,
			running,
			pty: ptyManager.get(session.id),
		} satisfies WuuSessionState;
	});

	const patchStates = (await listPatchesForKnownTasks(store, patchStore)).map(patch => ({
		patch,
		task: taskMap.get(patch.taskId),
	}));

	taskProvider.setData(taskStates, sessionStates);
	patchProvider.setData(patchStates);
}

async function inspectTask(task: WuuTaskRecord, patchSummary: WuuPatchSummary): Promise<WuuTaskState> {
	if (!await pathExists(task.worktreePath)) {
		return {
			task,
			health: 'missing',
			changedFiles: 0,
			patchSummary,
			error: l10n.t('Worktree directory not found'),
		};
	}

	try {
		const changedFiles = await countChangedFiles(task.worktreePath);
		return {
			task,
			health: 'ready',
			changedFiles,
			patchSummary,
		};
	} catch (error) {
		return {
			task,
			health: 'error',
			changedFiles: 0,
			patchSummary,
			error: asErrorMessage(error),
		};
	}
}

async function removeTask(
	task: WuuTaskRecord,
	store: WuuStore,
	patchStore: WuuPatchStore,
	statusStore: WuuSessionStatusStore,
	ptyManager: WuuPtyManager,
): Promise<void> {
	const removeMetadataLabel = l10n.t('Remove Metadata');
	const removeWorktreeLabel = l10n.t('Remove Worktree');
	const picked = await window.showWarningMessage(
		l10n.t('Remove task "{0}"?', task.title),
		{ modal: true },
		removeMetadataLabel,
		removeWorktreeLabel,
	);

	if (!picked) {
		return;
	}

	if (picked === removeWorktreeLabel) {
		try {
			await runGit(['worktree', 'remove', task.worktreePath], task.repoRoot);
		} catch (error) {
			window.showErrorMessage(l10n.t('Failed to remove worktree: {0}', asErrorMessage(error)));
			return;
		}
	}

	const sessions = store.getSessions().filter(session => session.taskId === task.id);
	for (const session of sessions) {
		ptyManager.stop(session.id);
		statusStore.remove(session.id);
	}
	await store.saveSessionStatuses(statusStore.list());
	await store.removeSessionsForTask(task.id);
	await patchStore.removeForTask(task.repoRoot, task.id);
	await store.removeTask(task.id);
}

async function setSessionStatus(
	sessionId: string,
	status: WuuSessionStatusInfo,
	statusStore: WuuSessionStatusStore,
	store: WuuStore,
): Promise<void> {
	statusStore.set(sessionId, status);
	await store.saveSessionStatuses(statusStore.list());
}

async function pickTask(store: WuuStore): Promise<WuuTaskRecord | undefined> {
	const tasks = store.getTasks();
	if (tasks.length === 0) {
		window.showInformationMessage(l10n.t('No tasks available.'));
		return;
	}

	const picked = await window.showQuickPick(tasks.map(task => ({
		label: task.title,
		description: task.branch,
		detail: task.worktreePath,
		task,
	})), {
		title: l10n.t('Select Wuu Task'),
		ignoreFocusOut: true,
	});

	return picked?.task;
}

async function pickSession(store: WuuStore): Promise<WuuSessionRecord | undefined> {
	const sessions = store.getSessions();
	if (sessions.length === 0) {
		window.showInformationMessage(l10n.t('No sessions available.'));
		return;
	}

	const taskMap = new Map(store.getTasks().map(task => [task.id, task]));
	const picked = await window.showQuickPick(sessions.map(session => ({
		label: session.name,
		description: session.agent,
		detail: taskMap.get(session.taskId)?.title ?? l10n.t('Missing task'),
		session,
	})), {
		title: l10n.t('Select Wuu Session'),
		ignoreFocusOut: true,
	});

	return picked?.session;
}

function getPrimaryWorkspaceFolder(): WorkspaceFolder | undefined {
	return workspace.workspaceFolders?.[0];
}

function resolveWorktreesRoot(workspaceFolder: WorkspaceFolder, repoRoot: string): string {
	const template = workspace.getConfiguration('wuu', workspaceFolder.uri).get<string>('worktreesRoot', '${workspaceFolder}/.wuu/worktrees');
	return template
		.replaceAll('${workspaceFolder}', workspaceFolder.uri.fsPath)
		.replaceAll('${repoRoot}', repoRoot);
}

function createTaskId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createSessionId(): string {
	return `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createPatchId(): string {
	return `patch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function patchStatusLabel(status: WuuPatchStatus): string {
	switch (status) {
		case 'conflict':
			return l10n.t('Conflicts');
		case 'pending':
			return l10n.t('Pending');
		case 'applied':
			return l10n.t('Applied');
		case 'unsupported':
			return l10n.t('Unsupported');
	}
}

function patchIcon(status: WuuPatchStatus): ThemeIcon {
	switch (status) {
		case 'conflict':
			return new ThemeIcon('warning');
		case 'pending':
			return new ThemeIcon('clock');
		case 'applied':
			return new ThemeIcon('pass-filled');
		case 'unsupported':
			return new ThemeIcon('circle-slash');
	}
}

function toPatchContextValue(status: WuuPatchStatus): string {
	switch (status) {
		case 'conflict':
			return 'wuuPatchConflict';
		case 'pending':
			return 'wuuPatchPending';
		case 'applied':
			return 'wuuPatchApplied';
		case 'unsupported':
			return 'wuuPatchUnsupported';
	}
}

function patchLabel(patch: WuuPatchRecord): string {
	return `${patch.status.toUpperCase()} · ${new Date(patch.createdAt).toLocaleString()}`;
}

function patchDetails(patch: WuuPatchRecord): string {
	const unsupported = patch.unsupportedFiles.length > 0 ? ` · unsupported ${patch.unsupportedFiles.length}` : '';
	const suffix = patch.patchPath ? patch.patchPath : l10n.t('No patch file');
	return `${patch.changedFiles} files${unsupported} · ${suffix}`;
}

function toPatchTooltip(state: WuuPatchState): string {
	const lines = [
		`${l10n.t('Task')}: ${state.task?.title ?? l10n.t('Missing task')}`,
		`${l10n.t('Source branch')}: ${state.patch.sourceBranch}`,
		`${l10n.t('Status')}: ${patchStatusLabel(state.patch.status)}`,
		`${l10n.t('Changed files')}: ${state.patch.changedFiles}`,
		`${l10n.t('Created')}: ${state.patch.createdAt}`,
	];

	if (state.patch.appliedAt) {
		lines.push(`${l10n.t('Applied at')}: ${state.patch.appliedAt}`);
	}
	if (state.patch.appliedBranch) {
		lines.push(`${l10n.t('Applied branch')}: ${state.patch.appliedBranch}`);
	}
	if (state.patch.error) {
		lines.push(`${l10n.t('Error')}: ${state.patch.error}`);
	}
	if (state.patch.unsupportedFiles.length > 0) {
		lines.push(`${l10n.t('Unsupported files')}: ${state.patch.unsupportedFiles.length}`);
	}
	if (state.patch.patchPath) {
		lines.push(`${l10n.t('Patch path')}: ${state.patch.patchPath}`);
	}

	return lines.join('\n');
}

function parseNumstatLine(line: string): { additions: string; deletions: string; filePath: string } | undefined {
	const parts = line.split('\t');
	if (parts.length < 3) {
		return undefined;
	}

	const [additions, deletions, ...fileParts] = parts;
	return {
		additions,
		deletions,
		filePath: fileParts.join('\t'),
	};
}

async function isLikelyBinaryFile(filePath: string): Promise<boolean> {
	const handle = await fs.open(filePath, 'r');
	try {
		const probe = Buffer.alloc(8192);
		const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
		for (let i = 0; i < bytesRead; i++) {
			if (probe[i] === 0) {
				return true;
			}
		}
		return false;
	} finally {
		await handle.close();
	}
}

async function getCurrentBranch(repoRoot: string): Promise<string> {
	const { stdout } = await runGit(['branch', '--show-current'], repoRoot);
	return stdout.trim() || 'HEAD';
}

async function getGitRepositoryApi(repoRoot: string): Promise<GitRepositoryApi | undefined> {
	const extension = extensions.getExtension<GitExtensionApi>('vscode.git');
	if (!extension) {
		return undefined;
	}

	const git = extension.isActive ? extension.exports : await extension.activate();
	const api = git.getAPI(1);
	return api.repositories.find(repository => repository.rootUri.fsPath === repoRoot);
}

function asErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

function toTaskTooltip(state: WuuTaskState, sessionCount: number, patchSummary: WuuPatchSummary): string {
	const lines = [
		`${l10n.t('Task')}: ${state.task.title}`,
		`${l10n.t('Branch')}: ${state.task.branch}`,
		`${l10n.t('Worktree')}: ${state.task.worktreePath}`,
		`${l10n.t('Changed files')}: ${state.changedFiles}`,
		`${l10n.t('Sessions')}: ${sessionCount}`,
		`${l10n.t('Patches (pending/applied/conflict/unsupported)')}: ${patchSummary.pending}/${patchSummary.applied}/${patchSummary.conflict}/${patchSummary.unsupported}`,
		`${l10n.t('Created')}: ${state.task.createdAt}`,
	];

	if (state.error) {
		lines.push(`${l10n.t('Error')}: ${state.error}`);
	}

	return lines.join('\n');
}

function toSessionContextValue(state: WuuSessionState): string {
	if (state.status.type === 'retry') {
		return 'wuuSessionRetry';
	}
	if (state.running) {
		return 'wuuSessionRunning';
	}
	return 'wuuSessionIdle';
}

function toSessionDescription(state: WuuSessionState): string {
	if (state.status.type === 'retry') {
		return l10n.t('{0} · retry #{1}', state.session.agent, state.status.attempt);
	}
	if (state.running) {
		return l10n.t('{0} · running', state.session.agent);
	}

	return l10n.t('{0} · idle', state.session.agent);
}

function toSessionTooltip(state: WuuSessionState): string {
	const lines = [
		`${l10n.t('Session')}: ${state.session.name}`,
		`${l10n.t('Agent')}: ${state.session.agent}`,
		`${l10n.t('Task')}: ${state.task?.title ?? l10n.t('Missing task')}`,
		`${l10n.t('Command')}: ${state.session.commandLine}`,
		`${l10n.t('Status')}: ${statusLabel(state.status)}`,
		`${l10n.t('Created')}: ${state.session.createdAt}`,
	];

	if (state.pty?.pid !== undefined) {
		lines.push(`${l10n.t('PID')}: ${state.pty.pid}`);
	}

	if (state.status.type === 'retry') {
		lines.push(`${l10n.t('Retry message')}: ${state.status.message}`);
		lines.push(`${l10n.t('Retry at')}: ${new Date(state.status.next).toISOString()}`);
	}

	return lines.join('\n');
}

function statusLabel(status: WuuSessionStatusInfo): string {
	if (status.type === 'retry') {
		return l10n.t('retry');
	}
	return status.type;
}
