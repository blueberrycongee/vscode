/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import test from 'node:test';
import { WuuPatchRecord, WuuPatchStore } from './patchState';

function createPatchRecord(overrides?: Partial<WuuPatchRecord>): WuuPatchRecord {
	return {
		id: `patch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		taskId: 'task-1',
		repoRoot: '/tmp/repo',
		sourceBranch: 'codex/test',
		patchPath: '/tmp/repo/.wuu/patches/task-1/a.patch',
		status: 'pending',
		createdAt: new Date().toISOString(),
		changedFiles: 2,
		unsupportedFiles: [],
		...overrides,
	};
}

test('patch store persists and reads patch records', async () => {
	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wuu-patch-store-'));
	const store = new WuuPatchStore();

	const patch = createPatchRecord({ repoRoot });
	await store.add(repoRoot, patch);

	const patches = await store.list(repoRoot);
	assert.strictEqual(patches.length, 1);
	assert.strictEqual(patches[0].id, patch.id);
});

test('patch store summarizes status counts per task', async () => {
	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wuu-patch-summary-'));
	const store = new WuuPatchStore();

	await store.add(repoRoot, createPatchRecord({ repoRoot, taskId: 'task-a', status: 'pending' }));
	await store.add(repoRoot, createPatchRecord({ repoRoot, taskId: 'task-a', status: 'conflict' }));
	await store.add(repoRoot, createPatchRecord({ repoRoot, taskId: 'task-a', status: 'applied' }));
	await store.add(repoRoot, createPatchRecord({ repoRoot, taskId: 'task-b', status: 'unsupported' }));

	const summaryMap = await store.summarizeByTask([repoRoot]);
	const taskA = summaryMap.get('task-a');
	const taskB = summaryMap.get('task-b');

	assert.ok(taskA);
	assert.strictEqual(taskA.pending, 1);
	assert.strictEqual(taskA.conflict, 1);
	assert.strictEqual(taskA.applied, 1);
	assert.strictEqual(taskA.unsupported, 0);

	assert.ok(taskB);
	assert.strictEqual(taskB.unsupported, 1);
	assert.strictEqual(taskB.total, 1);
});

test('patch store removes patches for a specific task', async () => {
	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wuu-patch-remove-'));
	const store = new WuuPatchStore();

	await store.add(repoRoot, createPatchRecord({ repoRoot, taskId: 'task-a' }));
	await store.add(repoRoot, createPatchRecord({ repoRoot, taskId: 'task-b' }));

	await store.removeForTask(repoRoot, 'task-a');
	const patches = await store.list(repoRoot);

	assert.strictEqual(patches.length, 1);
	assert.strictEqual(patches[0].taskId, 'task-b');
});
