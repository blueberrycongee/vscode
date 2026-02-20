/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import { pathExists } from './git';

const WUU_STATE_VERSION = 1;
const WUU_DIRECTORY_NAME = '.wuu';
const PATCH_DIRECTORY_NAME = 'patches';
const STATE_FILE_NAME = 'state.json';

export type WuuPatchStatus = 'pending' | 'applied' | 'conflict' | 'unsupported';

export interface WuuPatchRecord {
	id: string;
	taskId: string;
	repoRoot: string;
	sourceBranch: string;
	patchPath: string;
	status: WuuPatchStatus;
	createdAt: string;
	changedFiles: number;
	unsupportedFiles: string[];
	appliedAt?: string;
	appliedBranch?: string;
	error?: string;
}

export interface WuuPatchSummary {
	total: number;
	pending: number;
	applied: number;
	conflict: number;
	unsupported: number;
}

interface WuuStateFile {
	version: number;
	patches: WuuPatchRecord[];
}

const EMPTY_SUMMARY: WuuPatchSummary = {
	total: 0,
	pending: 0,
	applied: 0,
	conflict: 0,
	unsupported: 0,
};

export class WuuPatchStore {
	async list(repoRoot: string): Promise<WuuPatchRecord[]> {
		const state = await this.readState(repoRoot);
		return state.patches
			.slice()
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async add(repoRoot: string, patch: WuuPatchRecord): Promise<void> {
		const state = await this.readState(repoRoot);
		state.patches.push(patch);
		await this.writeState(repoRoot, state);
	}

	async update(repoRoot: string, patchId: string, update: (current: WuuPatchRecord) => WuuPatchRecord): Promise<WuuPatchRecord | undefined> {
		const state = await this.readState(repoRoot);
		const index = state.patches.findIndex(patch => patch.id === patchId);
		if (index < 0) {
			return undefined;
		}

		const next = update(state.patches[index]);
		state.patches[index] = next;
		await this.writeState(repoRoot, state);
		return next;
	}

	async remove(repoRoot: string, patchId: string): Promise<boolean> {
		const state = await this.readState(repoRoot);
		const index = state.patches.findIndex(patch => patch.id === patchId);
		if (index < 0) {
			return false;
		}

		const [removed] = state.patches.splice(index, 1);
		await this.writeState(repoRoot, state);
		if (removed.patchPath) {
			await fs.unlink(removed.patchPath).catch(() => undefined);
		}

		return true;
	}

	async removeForTask(repoRoot: string, taskId: string): Promise<void> {
		const state = await this.readState(repoRoot);
		const removedPatches = state.patches.filter(patch => patch.taskId === taskId);
		const nextPatches = state.patches.filter(patch => patch.taskId !== taskId);
		if (nextPatches.length === state.patches.length) {
			return;
		}

		state.patches = nextPatches;
		await this.writeState(repoRoot, state);
		for (const patch of removedPatches) {
			if (!patch.patchPath) {
				continue;
			}
			await fs.unlink(patch.patchPath).catch(() => undefined);
		}
	}

	async summarizeByTask(repoRoots: readonly string[]): Promise<Map<string, WuuPatchSummary>> {
		const uniqueRoots = [...new Set(repoRoots)];
		const patchLists = await Promise.all(uniqueRoots.map(root => this.list(root)));
		const summaryMap = new Map<string, WuuPatchSummary>();

		for (const patches of patchLists) {
			for (const patch of patches) {
				const current = summaryMap.get(patch.taskId) ?? { ...EMPTY_SUMMARY };
				current.total++;

				switch (patch.status) {
					case 'pending':
						current.pending++;
						break;
					case 'applied':
						current.applied++;
						break;
					case 'conflict':
						current.conflict++;
						break;
					case 'unsupported':
						current.unsupported++;
						break;
				}

				summaryMap.set(patch.taskId, current);
			}
		}

		return summaryMap;
	}

	async ensurePatchDirectory(repoRoot: string, taskId: string): Promise<string> {
		const directory = path.join(this.resolvePatchRoot(repoRoot), taskId);
		await fs.mkdir(directory, { recursive: true });
		return directory;
	}

	private async readState(repoRoot: string): Promise<WuuStateFile> {
		const stateFile = this.resolveStateFile(repoRoot);
		if (!await pathExists(stateFile)) {
			return this.createEmptyState();
		}

		try {
			const raw = await fs.readFile(stateFile, 'utf8');
			const parsed = JSON.parse(raw) as Partial<WuuStateFile>;
			if (!Array.isArray(parsed.patches)) {
				return this.createEmptyState();
			}

			return {
				version: parsed.version === WUU_STATE_VERSION ? parsed.version : WUU_STATE_VERSION,
				patches: parsed.patches.filter(isPatchRecord),
			};
		} catch {
			return this.createEmptyState();
		}
	}

	private async writeState(repoRoot: string, state: WuuStateFile): Promise<void> {
		const stateFile = this.resolveStateFile(repoRoot);
		const stateDirectory = path.dirname(stateFile);
		await fs.mkdir(stateDirectory, { recursive: true });

		const tmpFile = `${stateFile}.${Date.now()}.tmp`;
		await fs.writeFile(tmpFile, JSON.stringify(state, null, '\t') + '\n', 'utf8');
		await fs.rename(tmpFile, stateFile);
	}

	private createEmptyState(): WuuStateFile {
		return {
			version: WUU_STATE_VERSION,
			patches: [],
		};
	}

	private resolvePatchRoot(repoRoot: string): string {
		return path.join(repoRoot, WUU_DIRECTORY_NAME, PATCH_DIRECTORY_NAME);
	}

	private resolveStateFile(repoRoot: string): string {
		return path.join(repoRoot, WUU_DIRECTORY_NAME, STATE_FILE_NAME);
	}
}

export function emptyPatchSummary(): WuuPatchSummary {
	return { ...EMPTY_SUMMARY };
}

function isPatchRecord(value: unknown): value is WuuPatchRecord {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const patch = value as Partial<WuuPatchRecord>;
	if (typeof patch.id !== 'string') {
		return false;
	}
	if (typeof patch.taskId !== 'string') {
		return false;
	}
	if (typeof patch.repoRoot !== 'string') {
		return false;
	}
	if (typeof patch.sourceBranch !== 'string') {
		return false;
	}
	if (typeof patch.patchPath !== 'string') {
		return false;
	}
	if (typeof patch.status !== 'string') {
		return false;
	}
	if (typeof patch.createdAt !== 'string') {
		return false;
	}
	if (typeof patch.changedFiles !== 'number') {
		return false;
	}
	if (!Array.isArray(patch.unsupportedFiles)) {
		return false;
	}

	return true;
}
