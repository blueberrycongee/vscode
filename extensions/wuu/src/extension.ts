/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import {
	commands,
	Event,
	EventEmitter,
	ExtensionContext,
	l10n,
	ThemeIcon,
	TreeDataProvider,
	TreeItem,
	TreeItemCollapsibleState,
	Uri,
	window,
	workspace,
	WorkspaceFolder,
} from 'vscode';
import { countChangedFiles, pathExists, resolveRepositoryRoot, runGit } from './git';
import { defaultBranchName, toSlug } from './naming';
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
	error?: string;
}

interface WuuSessionState {
	session: WuuSessionRecord;
	task: WuuTaskRecord | undefined;
	status: WuuSessionStatusInfo;
	running: boolean;
	pty?: WuuPtyInfo;
}

type WuuTreeItem = WuuTaskItem | WuuSessionItem;

class WuuTaskItem extends TreeItem {
	constructor(
		public readonly state: WuuTaskState,
		public readonly sessionCount: number,
	) {
		super(state.task.title, sessionCount > 0 ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None);
		this.contextValue = 'wuuTask';
		this.description = l10n.t('{0} · {1} files · {2} sessions', state.task.branch, state.changedFiles, sessionCount);
		this.tooltip = toTaskTooltip(state, sessionCount);
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
	const provider = new WuuTreeProvider();
	const ptyManager = new WuuPtyManager();
	const statusStore = new WuuSessionStatusStore(store.getSessionStatuses());

	context.subscriptions.push(
		ptyManager,
		window.createTreeView('wuu.tasks', { treeDataProvider: provider }),
		commands.registerCommand('wuu.createTask', async () => {
			await createTask(store);
			await refreshView(provider, store, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.refreshTasks', async () => {
			await refreshView(provider, store, statusStore, ptyManager);
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

			await removeTask(selected, store, statusStore, ptyManager);
			await refreshView(provider, store, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.createSession', async (item?: WuuTaskItem) => {
			const selectedTask = item?.state.task ?? await pickTask(store);
			if (!selectedTask) {
				return;
			}

			await createSession(selectedTask, store, statusStore, ptyManager);
			await refreshView(provider, store, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.startSession', async (item?: WuuSessionItem) => {
			const selectedSession = item?.state.session ?? await pickSession(store);
			if (!selectedSession) {
				return;
			}

			await startSession(selectedSession, store, statusStore, ptyManager);
			await refreshView(provider, store, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.stopSession', async (item?: WuuSessionItem) => {
			const selectedSession = item?.state.session ?? await pickSession(store);
			if (!selectedSession) {
				return;
			}

			await stopSession(selectedSession, store, statusStore, ptyManager);
			await refreshView(provider, store, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.openSessionTerminal', async (item?: WuuSessionItem) => {
			const selectedSession = item?.state.session ?? await pickSession(store);
			if (!selectedSession) {
				return;
			}

			await openSessionTerminal(selectedSession, store, statusStore, ptyManager);
			await refreshView(provider, store, statusStore, ptyManager);
		}),
		commands.registerCommand('wuu.removeSession', async (item?: WuuSessionItem) => {
			const selectedSession = item?.state.session ?? await pickSession(store);
			if (!selectedSession) {
				return;
			}

			await removeSession(selectedSession, store, statusStore, ptyManager);
			await refreshView(provider, store, statusStore, ptyManager);
		}),
		ptyManager.onDidExit(async event => {
			await setSessionStatus(event.sessionId, { type: 'idle' }, statusStore, store);
			await refreshView(provider, store, statusStore, ptyManager);
		}),
	);

	void initializeView(provider, store, statusStore, ptyManager);
}

export function deactivate(): void {
}

async function initializeView(
	provider: WuuTreeProvider,
	store: WuuStore,
	statusStore: WuuSessionStatusStore,
	ptyManager: WuuPtyManager,
): Promise<void> {
	for (const [sessionId, status] of Object.entries(statusStore.list())) {
		if (status.type === 'busy') {
			statusStore.set(sessionId, { type: 'idle' });
		}
	}
	await store.saveSessionStatuses(statusStore.list());
	await refreshView(provider, store, statusStore, ptyManager);
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

async function refreshView(
	provider: WuuTreeProvider,
	store: WuuStore,
	statusStore: WuuSessionStatusStore,
	ptyManager: WuuPtyManager,
): Promise<void> {
	const taskStates = await Promise.all(store.getTasks().map(task => inspectTask(task)));
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

	provider.setData(taskStates, sessionStates);
}

async function inspectTask(task: WuuTaskRecord): Promise<WuuTaskState> {
	if (!await pathExists(task.worktreePath)) {
		return {
			task,
			health: 'missing',
			changedFiles: 0,
			error: l10n.t('Worktree directory not found'),
		};
	}

	try {
		const changedFiles = await countChangedFiles(task.worktreePath);
		return {
			task,
			health: 'ready',
			changedFiles,
		};
	} catch (error) {
		return {
			task,
			health: 'error',
			changedFiles: 0,
			error: asErrorMessage(error),
		};
	}
}

async function removeTask(
	task: WuuTaskRecord,
	store: WuuStore,
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

function asErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

function toTaskTooltip(state: WuuTaskState, sessionCount: number): string {
	const lines = [
		`${l10n.t('Task')}: ${state.task.title}`,
		`${l10n.t('Branch')}: ${state.task.branch}`,
		`${l10n.t('Worktree')}: ${state.task.worktreePath}`,
		`${l10n.t('Changed files')}: ${state.changedFiles}`,
		`${l10n.t('Sessions')}: ${sessionCount}`,
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
