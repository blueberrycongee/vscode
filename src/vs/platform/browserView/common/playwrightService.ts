/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IPlaywrightService = createDecorator<IPlaywrightService>('playwrightService');

/**
 * A service that connects to a browser via CDP and runs Playwright scripts
 * in a sandboxed environment.
 *
 * Pages must be explicitly added via {@link addPage} (or implicitly via
 * {@link openPage}) before they can be interacted with.
 */
export interface IPlaywrightService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires when the set of tracked pages changes.
	 * The event value is the full list of currently tracked view IDs.
	 */
	readonly onDidChangeTrackedPages: Event<readonly string[]>;

	/**
	 * Add an existing browser view to the Playwright service so that chat
	 * tools can interact with it.
	 * @param viewId The browser view identifier.
	 */
	addPage(viewId: string): Promise<void>;

	/**
	 * Remove a browser view from the Playwright service.
	 * @param viewId The browser view identifier.
	 */
	removePage(viewId: string): Promise<void>;

	/**
	 * Whether the given page is currently tracked by the service.
	 */
	isPageAdded(viewId: string): Promise<boolean>;

	/**
	 * Opens a new page in the browser and returns its associated view ID.
	 * The page is automatically added to the tracked pages.
	 * @param url The URL to open in the new page.
	 * @returns The view ID of the newly opened page.
	 */
	openPage(url: string): Promise<string>;

	/**
	 * Gets a snapshot of the page's current state, including its DOM and visual representation.
	 * @param pageId The browser view ID identifying the page to snapshot.
	 * @param diff Whether to return an incremental diff since the last snapshot (including results from runScript).
	 * @returns The snapshot of the page's current state.
	 */
	getSnapshot(pageId: string, diff?: boolean): Promise<string>;

	/**
	 * Run a function with access to a Playwright page.
	 * The first function argument is always the Playwright `page` object, and additional arguments can be passed after.
	 * @param pageId The browser view ID identifying the page to operate on.
	 * @param fnDef The function code to execute. Should contain the function definition but not its invocation, e.g. `async (page, arg1, arg2) => { ... }`.
	 * @param args Additional arguments to pass to the function after the `page` object.
	 * @returns The result of the function execution, including a page snapshot.
	 */
	invokeFunction<TResult = unknown>(pageId: string, fnDef: string, ...args: unknown[]): Promise<{ result: TResult; snapshot: string }>;

	/**
	 * Takes a screenshot of the given page and returns it as a VSBuffer.
	 * @param pageId The browser view ID identifying the page to capture.
	 * @param selector Optional Playwright selector to capture a specific element instead of the full page.
	 * @param fullPage Whether to capture the full scrollable page instead of just the viewport.
	 * @returns The screenshot image data.
	 */
	captureScreenshot(pageId: string, selector?: string, fullPage?: boolean): Promise<VSBuffer>;
}
