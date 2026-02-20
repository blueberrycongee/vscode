/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type WuuSessionStatusInfo =
	| { type: 'idle' }
	| { type: 'busy' }
	| { type: 'retry'; attempt: number; message: string; next: number };

export class WuuSessionStatusStore {
	private readonly state = new Map<string, WuuSessionStatusInfo>();

	constructor(initialStatuses?: Record<string, WuuSessionStatusInfo>) {
		if (!initialStatuses) {
			return;
		}

		for (const [sessionId, status] of Object.entries(initialStatuses)) {
			if (status.type !== 'idle') {
				this.state.set(sessionId, status);
			}
		}
	}

	get(sessionId: string): WuuSessionStatusInfo {
		return this.state.get(sessionId) ?? { type: 'idle' };
	}

	list(): Record<string, WuuSessionStatusInfo> {
		return Object.fromEntries(this.state.entries());
	}

	set(sessionId: string, status: WuuSessionStatusInfo): void {
		if (status.type === 'idle') {
			this.state.delete(sessionId);
			return;
		}

		this.state.set(sessionId, status);
	}

	remove(sessionId: string): void {
		this.state.delete(sessionId);
	}
}
