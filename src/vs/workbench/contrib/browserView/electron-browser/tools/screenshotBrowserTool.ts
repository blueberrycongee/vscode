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

export const ScreenshotBrowserToolData: IToolData = {
	id: 'screenshot_page',
	toolReferenceName: 'screenshotPage',
	displayName: localize('screenshotBrowserTool.displayName', 'Screenshot Page'),
	userDescription: localize('screenshotBrowserTool.userDescription', 'Capture a screenshot of a browser page'),
	modelDescription: `Capture a screenshot of the current browser page. Requires a page ID from context or ${OpenPageToolId}. Returns a JPEG image. Optionally target a specific element with "selector" or "ref", or set "fullPage" to capture the entire scrollable page.`,
	icon: Codicon.deviceCamera,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: {
				type: 'string',
				description: localize('screenshotBrowser.pageIdDescription', 'The browser page ID to capture.')
			},
			selector: {
				type: 'string',
				description: localize('screenshotBrowser.selectorDescription', 'Playwright selector of an element to capture. If omitted, captures the whole page.')
			},
			ref: {
				type: 'string',
				description: localize('screenshotBrowser.refDescription', 'Element reference to capture. If omitted, captures the whole page.')
			},
			fullPage: {
				type: 'boolean',
				description: localize('screenshotBrowser.fullPageDescription', 'Set to true to capture the full scrollable page instead of just the viewport. Incompatible with selector/ref.')
			},
		},
		required: ['pageId'],
	},
};

interface IScreenshotBrowserToolParams {
	pageId: string;
	selector?: string;
	ref?: string;
	fullPage?: boolean;
}

export class ScreenshotBrowserTool implements IToolImpl {
	constructor(
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
	) { }

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return {
			invocationMessage: localize('browser.screenshot.invocation', "Capturing browser screenshot"),
			pastTenseMessage: localize('browser.screenshot.past', "Captured browser screenshot"),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IScreenshotBrowserToolParams;

		if (!params.pageId) {
			return errorResult(localize('browser.noPageId', 'No page ID provided. Use "{0}" first to get a page ID.', OpenPageToolId));
		}

		let selector = params.selector;
		if (params.ref) {
			selector = `aria-ref=${params.ref}`;
		}

		const screenshot = await this.playwrightService.captureScreenshot(params.pageId, selector, params.fullPage);

		return {
			content: [
				{
					kind: 'data',
					value: {
						mimeType: 'image/jpeg',
						data: screenshot,
					},
				},
			],
		};
	}
}
