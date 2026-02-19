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

export const ClickBrowserToolData: IToolData = {
	id: 'click_element',
	toolReferenceName: 'clickElement',
	displayName: localize('clickBrowserTool.displayName', 'Click Element'),
	userDescription: localize('clickBrowserTool.userDescription', 'Click an element in a browser page'),
	modelDescription: `Click on an element in a browser page. Requires a page ID from context or ${OpenPageToolId}. Provide either a Playwright selector or an element reference to identify the target. Set "dblClick" to true for double clicks. Use "button" to specify which mouse button to use (default is "left").`,
	icon: Codicon.cursor,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: {
				type: 'string',
				description: localize('clickBrowser.pageIdDescription', 'The browser page ID.')
			},
			selector: {
				type: 'string',
				description: localize('clickBrowser.selectorDescription', 'Playwright selector of the element to click.')
			},
			ref: {
				type: 'string',
				description: localize('clickBrowser.refDescription', 'Element reference to click. One of "selector" or "ref" must be provided.')
			},
			dblClick: {
				type: 'boolean',
				description: localize('clickBrowser.dblClickDescription', 'Set to true for double clicks. Default is false.')
			},
			button: {
				type: 'string',
				enum: ['left', 'right', 'middle'],
				description: localize('clickBrowser.buttonDescription', 'Mouse button to use. Default is "left".')
			},
		},
		required: ['pageId'],
	},
};

interface IClickBrowserToolParams {
	pageId: string;
	selector?: string;
	ref?: string;
	dblClick?: boolean;
	button?: 'left' | 'right' | 'middle';
}

export class ClickBrowserTool implements IToolImpl {
	constructor(
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
	) { }

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return {
			invocationMessage: localize('browser.click.invocation', "Clicking element in browser"),
			pastTenseMessage: localize('browser.click.past', "Clicked element in browser"),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IClickBrowserToolParams;

		if (!params.pageId) {
			return errorResult(localize('browser.noPageId', 'No page ID provided. Use "{0}" first to get a page ID.', OpenPageToolId));
		}

		let selector = params.selector;
		if (params.ref) {
			selector = `aria-ref=${params.ref}`;
		}

		if (!selector) {
			return errorResult(localize('browser.click.noSelector', 'Either a "selector" or "ref" parameter is required.'));
		}

		const button = params.button ?? 'left';

		if (params.dblClick) {
			return playwrightInvoke(this.playwrightService, params.pageId, (page, sel, btn) => page.dblclick(sel, { button: btn }), selector, button);
		}

		return playwrightInvoke(this.playwrightService, params.pageId, (page, sel, btn) => page.click(sel, { button: btn }), selector, button);
	}
}
