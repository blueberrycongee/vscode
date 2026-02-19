/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { ILogService } from '../../log/common/log.js';
import { IPlaywrightService } from '../common/playwrightService.js';
import { IBrowserViewGroupRemoteService } from '../node/browserViewGroupRemoteService.js';
import { IBrowserViewGroup } from '../common/browserViewGroup.js';
import { VSBuffer } from '../../../base/common/buffer.js';

// eslint-disable-next-line local/code-import-patterns
import type { Browser, BrowserContext, Page } from 'playwright-core';

declare module 'playwright-core' {
	interface Page {
		// A hidden Playwright method that returns an AI-friendly snapshot of the page.
		_snapshotForAI(options?: { track?: string }): Promise<{ full: string; incremental?: string }>;
	}
}

/**
 * Shared-process implementation of {@link IPlaywrightService}.
 *
 * Tracks which browser views are added and lazily initialises the Playwright
 * browser connection only when an operation that requires it is called.
 */
export class PlaywrightService extends Disposable implements IPlaywrightService {
	declare readonly _serviceBrand: undefined;

	private readonly _trackedPages = new Set<string>();

	private readonly _onDidChangeTrackedPages = this._register(new Emitter<readonly string[]>());
	readonly onDidChangeTrackedPages: Event<readonly string[]> = this._onDidChangeTrackedPages.event;

	private _browser: Browser | undefined;
	private _pages: PlaywrightPageManager | undefined;
	private _initPromise: Promise<PlaywrightPageManager> | undefined;

	constructor(
		@IBrowserViewGroupRemoteService private readonly browserViewGroupRemoteService: IBrowserViewGroupRemoteService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	// --- Page tracking (no Playwright required) ---

	async addPage(viewId: string): Promise<void> {
		if (this._trackedPages.has(viewId)) {
			return;
		}

		this._trackedPages.add(viewId);
		this._fireTrackedPagesChanged();

		if (this._pages) {
			await this._pages.addPage(viewId);
		}
	}

	async removePage(viewId: string): Promise<void> {
		if (!this._trackedPages.has(viewId)) {
			return;
		}

		this._trackedPages.delete(viewId);
		this._fireTrackedPagesChanged();

		if (this._pages) {
			await this._pages.removePage(viewId);
		}
	}

	async isPageAdded(viewId: string): Promise<boolean> {
		return this._trackedPages.has(viewId);
	}

	private _fireTrackedPagesChanged(): void {
		this._onDidChangeTrackedPages.fire([...this._trackedPages]);
	}

	// --- Playwright operations (lazy init) ---

	/**
	 * Ensure the Playwright browser connection and page map are initialized.
	 */
	async initialize(): Promise<PlaywrightPageManager> {
		if (this._pages) {
			return this._pages;
		}

		if (this._initPromise) {
			return this._initPromise;
		}

		this._initPromise = (async () => {
			try {
				this.logService.debug('[PlaywrightService] Creating browser view group');
				const group = this._register(await this.browserViewGroupRemoteService.createGroup());

				this.logService.debug('[PlaywrightService] Connecting to browser via CDP');
				const playwright = await import('playwright-core');
				const endpoint = await group.getDebugWebSocketEndpoint();
				const browser = await playwright.chromium.connectOverCDP(endpoint);

				this.logService.debug('[PlaywrightService] Connected to browser');

				// This can happen if the service was disposed while we were waiting for the connection. In that case, clean up immediately.
				if (this._initPromise === undefined) {
					browser.close().catch(() => { /* ignore */ });
					throw new Error('PlaywrightService was disposed during initialization');
				}

				const pageManager = this._register(new PlaywrightPageManager(group, browser, this.logService));

				browser.on('disconnected', () => {
					this.logService.debug('[PlaywrightService] Browser disconnected');
					if (this._browser === browser) {
						group.dispose();
						pageManager.dispose();

						this._browser = undefined;
						this._pages = undefined;
						this._initPromise = undefined;
					}
				});

				// Eagerly connect any pages that were tracked before initialization.
				await Promise.all(
					[...this._trackedPages].map(viewId =>
						pageManager.addPage(viewId)
					)
				);

				this._browser = browser;
				this._pages = pageManager;

				return pageManager;
			} catch (e) {
				this._initPromise = undefined;
				throw e;
			}
		})();

		return this._initPromise;
	}

	async openPage(url: string): Promise<string> {
		const pageMap = await this.initialize();
		const { page, viewId } = await pageMap.newPage();
		await page.goto(url, { waitUntil: 'domcontentloaded' });

		this._trackedPages.add(viewId);
		this._fireTrackedPagesChanged();

		return viewId;
	}

	async getSnapshot(pageId: string, diff = false): Promise<string> {
		const pageMap = await this.initialize();
		const page = await pageMap.getPage(pageId);
		return this.snapshotPage(page, diff);
	}

	async invokeFunction<TArgs extends unknown[], TReturn>(pageId: string, fnDef: string, ...args: TArgs): Promise<{ result: TReturn; snapshot: string }> {
		this.logService.info(`[PlaywrightService] Invoking function on view ${pageId}`);

		try {
			const pageMap = await this.initialize();
			const page = await pageMap.getPage(pageId);

			const fn = new Function('page', 'args', `return (${fnDef})(page, ...args)`) as (page: Page, args: TArgs) => Promise<TReturn>;
			const result = await fn(page, args);

			const snapshot = await this.snapshotPage(page, true);
			return { result, snapshot };
		} catch (err: unknown) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			this.logService.error('[PlaywrightService] Script execution failed:', errorMessage);
			throw err;
		}
	}

	async captureScreenshot(pageId: string, selector?: string, fullPage?: boolean): Promise<VSBuffer> {
		const pageMap = await this.initialize();
		const page = await pageMap.getPage(pageId);
		if (selector) {
			const element = page.locator(selector);
			const screenshotBuffer = await element.screenshot({ type: 'jpeg', quality: 80 });
			return VSBuffer.wrap(screenshotBuffer);
		}
		const screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: fullPage ?? false });
		return VSBuffer.wrap(screenshotBuffer);
	}

	private async snapshotPage(page: Page, diff = false): Promise<string> {
		// Note: track ID is arbitrary.
		const result = await page._snapshotForAI(diff ? { track: 'track' } : {});
		return result.incremental ?? result.full;
	}

	override dispose(): void {
		if (this._browser) {
			this._browser.close().catch(() => { /* ignore */ });
			this._browser = undefined;
		}
		this._initPromise = undefined;
		super.dispose();
	}
}

/**
 * Correlates browser view IDs with Playwright {@link Page} instances.
 *
 * When a browser view is added to a group, two asynchronous events follow
 * through independent channels:
 *
 * 1. The group fires {@link IBrowserViewGroup.onDidAddView} (via IPC).
 * 2. Playwright receives a CDP `Target.targetCreated` event (via WebSocket)
 *    and fires a `page` event on the matching {@link BrowserContext}.
 *
 * This class pairs the two event streams by FIFO ordering: the first view-ID
 * received is matched with the first page event received.
 *
 * A periodic scan handles the case where Playwright creates a new
 * {@link BrowserContext} for a target whose session was previously unknown.
 */
class PlaywrightPageManager extends Disposable {

	private readonly _viewIdToPage = new Map<string, Page>();
	private readonly _pageToViewId = new WeakMap<Page, string>();

	/** View IDs received from the group but not yet matched with a page. */
	private _viewIdQueue: Array<{
		viewId: string;
		page: DeferredPromise<Page>;
	}> = [];

	/** Pages received from Playwright but not yet matched with a view ID. */
	private _pageQueue: Array<{
		page: Page;
		viewId: DeferredPromise<string>;
	}> = [];

	private readonly _watchedContexts = new WeakSet<BrowserContext>();
	private _scanTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly _group: IBrowserViewGroup,
		private readonly _browser: Browser,
		private readonly logService: ILogService,
	) {
		super();

		this._register(_group.onDidAddView(e => this.onViewAdded(e.viewId)));
		this._register(_group.onDidRemoveView(e => this.onViewRemoved(e.viewId)));
		this.scanForNewContexts();
	}

	/**
	 * Create a new page in the browser and return its associated page and view ID.
	 */
	async newPage(): Promise<{ viewId: string; page: Page }> {
		const page = await this._browser.newPage();
		const viewId = await this.onPageAdded(page);

		return { viewId, page };
	}

	/**
	 * Explicitly add an existing browser view to the CDP group.
	 */
	async addPage(viewId: string): Promise<void> {
		if (this._viewIdToPage.has(viewId)) {
			return;
		}
		if (this._viewIdQueue.some(item => item.viewId === viewId)) {
			return;
		}

		// ensure the viewId is queued so we can immediately fetch the promise via getPage().
		this.onViewAdded(viewId);

		try {
			await this._group.addView(viewId);
		} catch (err: unknown) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			this.logService.error('[PlaywrightPageMap] Failed to add view:', errorMessage);
			this.onViewRemoved(viewId);
		}
	}

	/**
	 * Remove a browser view from the CDP group.
	 */
	async removePage(viewId: string): Promise<void> {
		this.onViewRemoved(viewId);
		try {
			await this._group.removeView(viewId);
		} catch (err: unknown) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			this.logService.error('[PlaywrightPageMap] Failed to remove view:', errorMessage);
		}
	}

	/**
	 * Get the Playwright {@link Page} for a browser view that has already been added.
	 * Throws if the view has not been added.
	 */
	async getPage(viewId: string): Promise<Page> {
		const resolved = this._viewIdToPage.get(viewId);
		if (resolved) {
			return resolved;
		}
		const queued = this._viewIdQueue.find(item => item.viewId === viewId);
		if (queued) {
			return queued.page.p;
		}

		throw new Error(`Page "${viewId}" has not been added to the Playwright service`);
	}

	/**
	 * Called when the group fires onDidAddView. Creates a deferred entry in
	 * the view ID queue and attempts to match it with a page.
	 */
	private onViewAdded(viewId: string, timeoutMs = 10000): Promise<Page> {
		const resolved = this._viewIdToPage.get(viewId);
		if (resolved) {
			return Promise.resolve(resolved);
		}
		const queued = this._viewIdQueue.find(item => item.viewId === viewId);
		if (queued) {
			return queued.page.p;
		}

		const deferred = new DeferredPromise<Page>();
		const timeout = setTimeout(() => deferred.error(new Error(`Timed out waiting for page`)), timeoutMs);

		deferred.p.finally(() => {
			clearTimeout(timeout);
			this._viewIdQueue = this._viewIdQueue.filter(item => item.viewId !== viewId);
			if (this._viewIdQueue.length === 0) {
				this.stopScanning();
			}
		});

		this._viewIdQueue.push({ viewId, page: deferred });
		this.tryMatch();
		this.ensureScanning();

		return deferred.p;
	}

	private onViewRemoved(viewId: string): void {
		this._viewIdQueue = this._viewIdQueue.filter(item => item.viewId !== viewId);
		const page = this._viewIdToPage.get(viewId);
		if (page) {
			this._pageToViewId.delete(page);
		}
		this._viewIdToPage.delete(viewId);
	}

	private onPageAdded(page: Page, timeoutMs = 10000): Promise<string> {
		const resolved = this._pageToViewId.get(page);
		if (resolved) {
			return Promise.resolve(resolved);
		}
		const queued = this._pageQueue.find(item => item.page === page);
		if (queued) {
			return queued.viewId.p;
		}

		this.onContextAdded(page.context());
		page.once('close', () => this.onPageRemoved(page));

		const deferred = new DeferredPromise<string>();
		const timeout = setTimeout(() => deferred.error(new Error(`Timed out waiting for browser view`)), timeoutMs);
		deferred.p.finally(() => {
			clearTimeout(timeout);
			this._pageQueue = this._pageQueue.filter(item => item.page !== page);
		});

		this._pageQueue.push({ page, viewId: deferred });
		this.tryMatch();

		return deferred.p;
	}

	private onPageRemoved(page: Page): void {
		this._pageQueue = this._pageQueue.filter(item => item.page !== page);
		const viewId = this._pageToViewId.get(page);
		if (viewId) {
			this._viewIdToPage.delete(viewId);
		}
		this._pageToViewId.delete(page);
	}

	private onContextAdded(context: BrowserContext): void {
		if (this._watchedContexts.has(context)) {
			return;
		}
		this._watchedContexts.add(context);

		context.on('page', (page: Page) => this.onPageAdded(page));
		context.on('close', () => this.onContextRemoved(context));

		for (const page of context.pages()) {
			this.onPageAdded(page);
		}
	}

	private onContextRemoved(context: BrowserContext): void {
		this._watchedContexts.delete(context);
	}

	// --- Matching ---

	/**
	 * Pair up queued view IDs with queued pages in FIFO order and resolve
	 * any callers waiting for the matched view IDs.
	 */
	private tryMatch(): void {
		while (this._viewIdQueue.length > 0 && this._pageQueue.length > 0) {
			const viewIdItem = this._viewIdQueue.shift()!;
			const pageItem = this._pageQueue.shift()!;

			this._viewIdToPage.set(viewIdItem.viewId, pageItem.page);
			this._pageToViewId.set(pageItem.page, viewIdItem.viewId);

			viewIdItem.page.complete(pageItem.page);
			pageItem.viewId.complete(viewIdItem.viewId);

			this.logService.debug(`[PlaywrightPageMap] Matched view ${viewIdItem.viewId} → page`);
		}

		if (this._viewIdQueue.length === 0) {
			this.stopScanning();
		}
	}

	// --- Context scanning ---

	/**
	 * Watch all current {@link BrowserContext BrowserContexts} for new pages.
	 * Also processes any existing pages in newly discovered contexts.
	 */
	private scanForNewContexts(): void {
		for (const context of this._browser.contexts()) {
			this.onContextAdded(context);
		}
	}

	private ensureScanning(): void {
		if (this._scanTimer === undefined) {
			this._scanTimer = setInterval(() => this.scanForNewContexts(), 100);
		}
	}

	private stopScanning(): void {
		if (this._scanTimer !== undefined) {
			clearInterval(this._scanTimer);
			this._scanTimer = undefined;
		}
	}

	override dispose(): void {
		this.stopScanning();
		for (const { page } of this._viewIdQueue) {
			page.error(new Error('PlaywrightPageMap disposed'));
		}
		for (const { viewId } of this._pageQueue) {
			viewId.error(new Error('PlaywrightPageMap disposed'));
		}
		this._viewIdQueue = [];
		this._pageQueue = [];
		super.dispose();
	}
}
