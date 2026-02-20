/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import test from 'node:test';
import { WuuSessionStatusStore } from './sessionStatus';

test('status store defaults unknown sessions to idle', () => {
	const store = new WuuSessionStatusStore();
	assert.deepStrictEqual(store.get('missing'), { type: 'idle' });
});

test('status store drops idle entries from list', () => {
	const store = new WuuSessionStatusStore();
	store.set('s1', { type: 'busy' });
	store.set('s1', { type: 'idle' });
	assert.deepStrictEqual(store.list(), {});
});

test('status store persists retry metadata', () => {
	const store = new WuuSessionStatusStore();
	store.set('s2', { type: 'retry', attempt: 2, message: 'boom', next: 123 });
	assert.deepStrictEqual(store.get('s2'), { type: 'retry', attempt: 2, message: 'boom', next: 123 });
});
