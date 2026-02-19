/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import { ToolDataSource, type CountTokensCallback, type IPreparedToolInvocation, type IToolData, type IToolImpl, type IToolInvocation, type IToolInvocationPreparationContext, type IToolResult, type ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { errorResult, playwrightInvoke } from './browserToolHelpers.js';
import { OpenPageToolId } from './openBrowserTool.js';

export const TypeBrowserToolData: IToolData = {
	id: 'type_in_page',
	toolReferenceName: 'typeInPage',
	displayName: localize('typeBrowserTool.displayName', 'Type in Page'),
	userDescription: localize('typeBrowserTool.userDescription', 'Type text or press keys in a browser page'),
	modelDescription: `Type text or press keys in a browser page. Requires a page ID from context or ${OpenPageToolId}. Provide "text" to type characters, or "key" to press a key combination (e.g., "Enter", "Tab", "Control+c"). Optionally target a specific element with "selector" or "ref".`,
	icon: Codicon.symbolText,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: {
				type: 'string',
				description: localize('typeBrowser.pageIdDescription', 'The browser page ID.')
			},
			text: {
				type: 'string',
				description: localize('typeBrowser.textDescription', 'The text to type into the element.')
			},
			key: {
				type: 'string',
				description: localize('typeBrowser.keyDescription', 'A key or key combination to press (e.g., "Enter", "Tab", "Control+c").')
			},
			selector: {
				type: 'string',
				description: localize('typeBrowser.selectorDescription', 'Playwright selector of element to target (defaults to the page).')
			},
			ref: {
				type: 'string',
				description: localize('typeBrowser.refDescription', 'Element reference to target.')
			},
		},
		required: ['pageId'],
	},
};

interface ITypeBrowserToolParams {
	pageId: string;
	text?: string;
	key?: string;
	selector?: string;
	ref?: string;
}

export class TypeBrowserTool implements IToolImpl {
	constructor(
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as ITypeBrowserToolParams;
		if (params.key) {
			return {
				invocationMessage: localize('browser.pressKey.invocation', "Pressing key {0} in browser", params.key),
				pastTenseMessage: localize('browser.pressKey.past', "Pressed key {0} in browser", params.key),
			};
		}
		return {
			invocationMessage: localize('browser.type.invocation', "Typing text in browser"),
			pastTenseMessage: localize('browser.type.past', "Typed text in browser"),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as ITypeBrowserToolParams;

		if (!params.pageId) {
			return errorResult(localize('browser.noPageId', 'No page ID provided. Use "{0}" first to get a page ID.', OpenPageToolId));
		}

		let selector = params.selector;
		if (params.ref) {
			selector = `aria-ref=${params.ref}`;
		}

		if (!params.text && !params.key) {
			return errorResult(localize('browser.type.noInput', 'Either a "text" or "key" parameter is required.'));
		}

		// Press key
		if (params.key) {
			if (selector) {
				return playwrightInvoke(this.playwrightService, params.pageId, (page, sel, key) => page.press(sel, key), selector, params.key);
			}
			return playwrightInvoke(this.playwrightService, params.pageId, (page, key) => page.keyboard.press(key), params.key);
		}

		// Type text
		if (selector) {
			return playwrightInvoke(this.playwrightService, params.pageId, (page, sel, text) => page.type(sel, text), selector, params.text!);
		}
		return playwrightInvoke(this.playwrightService, params.pageId, (page, text) => page.keyboard.type(text), params.text!);
	}
}
