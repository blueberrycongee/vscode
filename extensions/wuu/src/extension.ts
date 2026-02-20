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

const TASKS_STORAGE_KEY = 'wuu.tasks';

interface WuuTaskRecord {
	id: string;
	title: string;
	repoRoot: string;
	branch: string;
	worktreePath: string;
	createdAt: string;
}

type TaskHealth = 'ready' | 'missing' | 'error';

interface WuuTaskState {
	task: WuuTaskRecord;
	health: TaskHealth;
	changedFiles: number;
	error?: string;
}

class WuuTaskItem extends TreeItem {
	constructor(public readonly state: WuuTaskState) {
		super(state.task.title, TreeItemCollapsibleState.None);
		this.contextValue = 'wuuTask';
		this.description = l10n.t('{0} · {1} files', state.task.branch, state.changedFiles);
		this.tooltip = toTooltip(state);
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

class WuuTaskTreeProvider implements TreeDataProvider<WuuTaskItem> {
	private readonly onDidChangeTreeDataEmitter = new EventEmitter<WuuTaskItem | null>();
	readonly onDidChangeTreeData: Event<WuuTaskItem | null> = this.onDidChangeTreeDataEmitter.event;
	private tasks: WuuTaskState[] = [];

	setTasks(tasks: WuuTaskState[]): void {
		this.tasks = tasks;
		this.onDidChangeTreeDataEmitter.fire(null);
	}

	refresh(): void {
		this.onDidChangeTreeDataEmitter.fire(null);
	}

	getTreeItem(element: WuuTaskItem): TreeItem {
		return element;
	}

	getChildren(): WuuTaskItem[] {
		return this.tasks.map(task => new WuuTaskItem(task));
	}
}

class WuuTaskStore {
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
		const next = this.getTasks().filter(task => task.id !== taskId);
		await this.saveTasks(next);
	}
}

export function activate(context: ExtensionContext): void {
	const store = new WuuTaskStore(context);
	const provider = new WuuTaskTreeProvider();

	context.subscriptions.push(
		window.createTreeView('wuu.tasks', { treeDataProvider: provider }),
		commands.registerCommand('wuu.createTask', async () => {
			await createTask(store);
			await refreshTasks(provider, store);
		}),
		commands.registerCommand('wuu.refreshTasks', async () => {
			await refreshTasks(provider, store);
		}),
		commands.registerCommand('wuu.openTask', async (item?: WuuTaskItem) => {
			const selected = item?.state.task ?? await pickTaskItem(store);
			if (!selected) {
				return;
			}

			await commands.executeCommand('vscode.openFolder', Uri.file(selected.worktreePath), true);
		}),
		commands.registerCommand('wuu.removeTask', async (item?: WuuTaskItem) => {
			const selected = item?.state.task ?? await pickTaskItem(store);
			if (!selected) {
				return;
			}

			await removeTask(selected, store);
			await refreshTasks(provider, store);
		}),
	);

	void refreshTasks(provider, store);
}

export function deactivate(): void {
}

async function createTask(store: WuuTaskStore): Promise<void> {
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

async function refreshTasks(provider: WuuTaskTreeProvider, store: WuuTaskStore): Promise<void> {
	const taskStates = await Promise.all(store.getTasks().map(task => inspectTask(task)));
	provider.setTasks(taskStates);
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

async function removeTask(task: WuuTaskRecord, store: WuuTaskStore): Promise<void> {
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

	await store.removeTask(task.id);
}

async function pickTaskItem(store: WuuTaskStore): Promise<WuuTaskRecord | undefined> {
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

function asErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

function toTooltip(state: WuuTaskState): string {
	const lines = [
		`${l10n.t('Task')}: ${state.task.title}`,
		`${l10n.t('Branch')}: ${state.task.branch}`,
		`${l10n.t('Worktree')}: ${state.task.worktreePath}`,
		`${l10n.t('Changed files')}: ${state.changedFiles}`,
		`${l10n.t('Created')}: ${state.task.createdAt}`,
	];

	if (state.error) {
		lines.push(`${l10n.t('Error')}: ${state.error}`);
	}

	return lines.join('\n');
}
