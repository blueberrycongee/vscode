/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	commands,
	Disposable,
	Event,
	EventEmitter,
	Terminal,
	ViewColumn,
	window,
} from 'vscode';

export interface WuuPtyInfo {
	sessionId: string;
	title: string;
	commandLine: string;
	cwd: string;
	status: 'running' | 'exited';
	pid?: number;
}

interface ActivePty {
	terminal: Terminal;
	info: WuuPtyInfo;
}

export class WuuPtyManager implements Disposable {
	private readonly sessions = new Map<string, ActivePty>();
	private readonly onDidExitEmitter = new EventEmitter<{ sessionId: string }>();
	readonly onDidExit: Event<{ sessionId: string }> = this.onDidExitEmitter.event;
	private readonly closeSubscription: Disposable;

	constructor() {
		this.closeSubscription = window.onDidCloseTerminal(terminal => {
			for (const [sessionId, active] of this.sessions.entries()) {
				if (active.terminal !== terminal) {
					continue;
				}

				active.info.status = 'exited';
				this.sessions.delete(sessionId);
				this.onDidExitEmitter.fire({ sessionId });
				break;
			}
		});
	}

	dispose(): void {
		for (const active of this.sessions.values()) {
			active.terminal.dispose();
		}
		this.sessions.clear();
		this.closeSubscription.dispose();
		this.onDidExitEmitter.dispose();
	}

	list(): WuuPtyInfo[] {
		return [...this.sessions.values()].map(active => active.info);
	}

	isRunning(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	get(sessionId: string): WuuPtyInfo | undefined {
		return this.sessions.get(sessionId)?.info;
	}

	start(sessionId: string, title: string, commandLine: string, cwd: string): WuuPtyInfo {
		const existing = this.sessions.get(sessionId);
		if (existing) {
			void this.revealInEditorSide(sessionId);
			return existing.info;
		}

		const terminal = window.createTerminal({
			name: title,
			cwd,
			location: {
				viewColumn: ViewColumn.Beside,
				preserveFocus: true,
			},
		});

		const info: WuuPtyInfo = {
			sessionId,
			title,
			commandLine,
			cwd,
			status: 'running',
		};

		this.sessions.set(sessionId, { terminal, info });
		terminal.show(true);
		terminal.sendText(commandLine, true);

		void terminal.processId.then(pid => {
			const active = this.sessions.get(sessionId);
			if (!active) {
				return;
			}
			active.info.pid = pid;
		});

		return info;
	}

	sendText(sessionId: string, text: string, shouldExecute: boolean): boolean {
		const active = this.sessions.get(sessionId);
		if (!active) {
			return false;
		}

		active.terminal.sendText(text, shouldExecute);
		return true;
	}

	stop(sessionId: string): boolean {
		const active = this.sessions.get(sessionId);
		if (!active) {
			return false;
		}

		active.terminal.dispose();
		return true;
	}

	reveal(sessionId: string): boolean {
		const active = this.sessions.get(sessionId);
		if (!active) {
			return false;
		}

		active.terminal.show(true);
		return true;
	}

	async revealInEditorSide(sessionId: string): Promise<boolean> {
		const active = this.sessions.get(sessionId);
		if (!active) {
			return false;
		}

		active.terminal.show(false);
		await commands.executeCommand('workbench.action.terminal.moveToEditor');
		return true;
	}
}
