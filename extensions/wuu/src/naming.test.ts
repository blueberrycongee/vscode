/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import test from 'node:test';
import { defaultBranchName, toSlug } from './naming';

test('toSlug strips non-alphanumeric separators', () => {
	assert.strictEqual(toSlug(' Fix Login: Timeout! '), 'fix-login-timeout');
});

test('toSlug returns fallback when input is empty', () => {
	assert.strictEqual(toSlug('@@@'), 'task');
});

test('defaultBranchName formats codex branch with timestamp', () => {
	const value = defaultBranchName('Fix Login Timeout', new Date('2026-02-20T09:07:00.000Z'));
	assert.match(value, /^codex\/fix-login-timeout-20260220-\d{4}$/);
});
