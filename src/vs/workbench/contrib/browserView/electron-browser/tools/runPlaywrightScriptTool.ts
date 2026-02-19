/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import { ToolDataSource, type CountTokensCallback, type IPreparedToolInvocation, type IToolData, type IToolImpl, type IToolInvocation, type IToolInvocationPreparationContext, type IToolResult, type ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { IChatTerminalToolInvocationData } from '../../../chat/common/chatService/chatService.js';
import { errorResult } from './browserToolHelpers.js';
import { OpenPageToolId } from './openBrowserTool.js';

export const RunPlaywrightScriptToolData: IToolData = {
	id: 'run_playwright_script',
	toolReferenceName: 'runPlaywrightScript',
	displayName: localize('runPlaywrightScriptTool.displayName', 'Run Playwright Script'),
	userDescription: localize('runPlaywrightScriptTool.userDescription', 'Run a Playwright script against a browser page'),
	modelDescription: `Run arbitrary Playwright code against a browser page. Only use this if other browser tools are insufficient. Requires a page ID from context or ${OpenPageToolId}. The "page" object is available in scope. Example: "return await page.title()".`,
	icon: Codicon.terminal,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: {
				type: 'string',
				description: localize('runPlaywrightScript.pageIdDescription', 'The browser page ID.')
			},
			code: {
				type: 'string',
				description: localize('runPlaywrightScript.codeDescription', 'The Playwright code to execute; the "page" object is available in scope. The code should be as minimal as possible and self-contained.')
			},
		},
		required: ['pageId', 'code'],
	},
};

interface IRunPlaywrightScriptToolParams {
	pageId: string;
	code: string;
}

export class RunPlaywrightScriptTool implements IToolImpl {
	constructor(
		@ILogService private readonly logService: ILogService,
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as IRunPlaywrightScriptToolParams;
		const code = params.code ?? '';
		const toolSpecificData: IChatTerminalToolInvocationData = {
			kind: 'terminal',
			commandLine: { original: code },
			presentationOverrides: { commandLine: code, language: 'javascript' },
			language: 'javascript',
		};
		return {
			invocationMessage: new MarkdownString(localize('browser.runScript.invocation', "Running Playwright script...")),
			pastTenseMessage: new MarkdownString(localize('browser.runScript.past', "Ran Playwright script")),
			confirmationMessages: {
				title: localize('browser.runScript.confirmTitle', 'Run Playwright Script?'),
				message: localize('browser.runScript.confirmMessage', 'This will execute the following script against the browser.'),
				allowAutoConfirm: true,
			},
			toolSpecificData,
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IRunPlaywrightScriptToolParams;

		if (!params.pageId) {
			return errorResult(localize('browser.noPageId', 'No page ID provided. Use "{0}" first to get a page ID.', OpenPageToolId));
		}

		if (!params.code) {
			return errorResult(localize('browser.runScript.noCode', 'The "code" parameter is required.'));
		}

		this.logService.info('[BrowserTool] Running script via CDP');

		let result;
		try {
			result = await this.playwrightService.invokeFunction(params.pageId, `async (page) => { ${params.code} }`);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			return errorResult(`Script execution failed: ${message}`);
		}

		const json = JSON.stringify(result.result || null);

		let outputMessage;
		if (result.result) {
			outputMessage = new MarkdownString();
			outputMessage.appendMarkdown(localize('browser.runScript.outputLabel', 'Script output:'));
			outputMessage.appendText('\n');
			outputMessage.appendCodeblock('json', json);
		}

		const parts: string[] = [];
		if (result.result) {
			parts.push(json);
		}
		if (result.snapshot) {
			parts.push(result.snapshot);
		}

		return {
			content: [{ kind: 'text', value: parts.join('\n\n') }],
			toolResultMessage: outputMessage,
		};
	}
}
