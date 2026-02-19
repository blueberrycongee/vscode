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

export const DragElementToolData: IToolData = {
	id: 'drag_element',
	toolReferenceName: 'dragElement',
	displayName: localize('dragElementTool.displayName', 'Drag Element'),
	userDescription: localize('dragElementTool.userDescription', 'Drag an element onto another element'),
	modelDescription: `Drag an element onto another element in a browser page. Requires a page ID from context or ${OpenPageToolId}. Provide source and target elements using selectors or refs.`,
	icon: Codicon.move,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: {
				type: 'string',
				description: localize('dragElement.pageIdDescription', 'The browser page ID.')
			},
			fromSelector: {
				type: 'string',
				description: localize('dragElement.fromSelectorDescription', 'Playwright selector of the element to drag.')
			},
			fromRef: {
				type: 'string',
				description: localize('dragElement.fromRefDescription', 'Element reference of the element to drag.')
			},
			toSelector: {
				type: 'string',
				description: localize('dragElement.toSelectorDescription', 'Playwright selector of the element to drop onto.')
			},
			toRef: {
				type: 'string',
				description: localize('dragElement.toRefDescription', 'Element reference of the element to drop onto.')
			},
		},
		required: ['pageId'],
	},
};

interface IDragElementToolParams {
	pageId: string;
	fromSelector?: string;
	fromRef?: string;
	toSelector?: string;
	toRef?: string;
}

export class DragElementTool implements IToolImpl {
	constructor(
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
	) { }

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return {
			invocationMessage: localize('browser.drag.invocation', "Dragging element in browser"),
			pastTenseMessage: localize('browser.drag.past', "Dragged element in browser"),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IDragElementToolParams;

		if (!params.pageId) {
			return errorResult(localize('browser.noPageId', 'No page ID provided. Use "{0}" first to get a page ID.', OpenPageToolId));
		}

		let fromSelector = params.fromSelector;
		if (params.fromRef) {
			fromSelector = `aria-ref=${params.fromRef}`;
		}
		if (!fromSelector) {
			return errorResult(localize('browser.drag.noFrom', 'Either a "fromSelector" or "fromRef" parameter is required for the source element.'));
		}

		let toSelector = params.toSelector;
		if (params.toRef) {
			toSelector = `aria-ref=${params.toRef}`;
		}
		if (!toSelector) {
			return errorResult(localize('browser.drag.noTo', 'Either a "toSelector" or "toRef" parameter is required for the target element.'));
		}

		return playwrightInvoke(this.playwrightService, params.pageId, (page, from, to) => page.dragAndDrop(from, to), fromSelector, toSelector);
	}
}
