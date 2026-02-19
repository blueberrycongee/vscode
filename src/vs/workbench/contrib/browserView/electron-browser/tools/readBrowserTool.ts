/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import { ToolDataSource, type CountTokensCallback, type IPreparedToolInvocation, type IToolData, type IToolImpl, type IToolInvocation, type IToolInvocationPreparationContext, type IToolResult, type ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { errorResult } from './browserToolHelpers.js';
import { OpenPageToolId } from './openBrowserTool.js';

export const ReadBrowserToolData: IToolData = {
	id: 'read_page',
	toolReferenceName: 'readPage',
	displayName: localize('readBrowserTool.displayName', 'Read Page'),
	userDescription: localize('readBrowserTool.userDescription', 'Read the content of a browser page'),
	modelDescription: `Get a snapshot of the current browser page state. Returns an accessibility-tree-based representation of the page content. Requires a page ID from context or ${OpenPageToolId}.`,
	icon: Codicon.fileText,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: {
				type: 'string',
				description: localize('readBrowser.pageIdDescription', 'The browser page ID to read.')
			},
		},
		required: ['pageId'],
	},
};

interface IReadBrowserToolParams {
	pageId: string;
}

export class ReadBrowserTool implements IToolImpl {
	constructor(
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
	) { }

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return {
			invocationMessage: localize('browser.read.invocation', "Reading browser page content"),
			pastTenseMessage: localize('browser.read.past', "Read browser page content"),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IReadBrowserToolParams;

		if (!params.pageId) {
			return errorResult(localize('browser.noPageId', 'No page ID provided. Use "{0}" first to get a page ID.', OpenPageToolId));
		}

		const snapshot = await this.playwrightService.getSnapshot(params.pageId);
		if (!snapshot) {
			return errorResult(localize('browser.read.noSnapshot', 'No page snapshot available.'));
		}

		return {
			content: [{
				kind: 'text',
				value: snapshot,
			}],
		};
	}
}
