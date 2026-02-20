/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';

export interface GitResult {
	stdout: string;
	stderr: string;
}

export async function runGit(args: string[], cwd: string): Promise<GitResult> {
	return await new Promise<GitResult>((resolve, reject) => {
		execFile('git', args, { cwd }, (error, stdout, stderr) => {
			if (error) {
				const message = stderr.trim() || stdout.trim() || error.message;
				reject(new Error(message));
				return;
			}

			resolve({ stdout, stderr });
		});
	});
}

export async function resolveRepositoryRoot(startPath: string): Promise<string> {
	const { stdout } = await runGit(['rev-parse', '--show-toplevel'], startPath);
	return stdout.trim();
}

export async function countChangedFiles(worktreePath: string): Promise<number> {
	const { stdout } = await runGit(['status', '--porcelain'], worktreePath);
	if (!stdout.trim()) {
		return 0;
	}

	return stdout
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean)
		.length;
}

export async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.access(targetPath);
		return true;
	} catch {
		return false;
	}
}
