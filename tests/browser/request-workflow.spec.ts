import { lstat, readFile, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const baseURL = process.env.PANTRY_E2E_BASE_URL;
const browserPath = process.env.PANTRY_E2E_BROWSER_PATH;
const password = process.env.PANTRY_E2E_PASSWORD;
const libraryRoot = process.env.PANTRY_E2E_SYNTHETIC_LIBRARY_ROOT;
if (!baseURL || !browserPath || !password || !libraryRoot || process.env.PANTRY_E2E_SYNTHETIC !== '1' ||
  new URL(baseURL).hostname !== '127.0.0.1') {
  throw new Error('Browser tests require a localhost synthetic app, generated library, browser path, and test-only accounts');
}

test.use({ baseURL, browserName: 'chromium', launchOptions: { executablePath: browserPath } });
test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);

async function signIn(page: Page, username: string) {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Browse projects' })).toBeVisible();
}

async function submit(page: Page, fileName: string, note: string) {
  await page.getByRole('checkbox', { name: new RegExp(fileName, 'i') }).check();
  await page.getByLabel('Quantity').fill('2');
  await page.getByLabel('Material').fill('PLA');
  await page.getByLabel('Color').fill('sage');
  await page.getByLabel('Notes', { exact: true }).fill(note);
  const response = page.waitForResponse((reply) => reply.url().endsWith('/api/requests') &&
    reply.request().method() === 'POST');
  await page.getByRole('button', { name: 'Submit print request' }).click();
  const result = await response;
  expect(result.status()).toBe(201);
  const body = await result.json() as { request: { id: string } };
  await expect(page.getByText(`Request ${body.request.id} submitted`, { exact: false })).toBeVisible();
  return body.request.id;
}

async function openProject(page: Page) {
  await page.getByRole('button', { name: 'Library' }).click();
  await page.getByRole('textbox', { name: 'Search projects' }).fill('Desk Tray');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Open Desk Tray' }).click();
  await expect(page.getByRole('heading', { name: 'Request this print' })).toBeVisible();
}

async function createRequesterContext(browser: Browser, mobile: boolean) {
  return browser.newContext({
    baseURL,
    viewport: { width: mobile ? 390 : 1365, height: mobile ? 844 : 900 },
    isMobile: mobile,
    hasTouch: mobile,
    permissions: ['clipboard-read', 'clipboard-write'],
    acceptDownloads: true,
  });
}

async function rescan(context: BrowserContext) {
  const before = await (await context.request.get('/api/catalog/status')).json() as {
    scan: { lastScan?: { id: string } };
  };
  const trigger = await context.request.post('/api/catalog/rescan');
  expect(trigger.status()).toBe(202);
  await expect.poll(async () => {
    const result = await (await context.request.get('/api/catalog/status')).json() as {
      scan: { state: string; lastScan?: { id: string } };
    };
    return result.scan.lastScan?.id !== before.scan.lastScan?.id && result.scan.state === 'succeeded';
  }, { timeout: 30_000 }).toBe(true);
}

for (const mobile of [false, true]) {
  test(`${mobile ? 'mobile' : 'desktop'} household browser journey`, async ({ browser }, testInfo) => {
    const suffix = `${mobile ? 'mobile' : 'desktop'}-${Date.now()}`;
    const requester = await createRequesterContext(browser, mobile);
    const operator = await browser.newContext({
      baseURL,
      viewport: { width: mobile ? 390 : 1365, height: mobile ? 844 : 900 },
      isMobile: mobile, hasTouch: mobile,
    });
    try {
      const page = await requester.newPage();
      await signIn(page, 'syntheticrequester');
      await expect(page.getByRole('button', { name: 'Requests' })).toBeVisible();
      await openProject(page);
      const fileRow = page.locator('.file-row').filter({ hasText: 'part 01.stl' });
      await fileRow.getByRole('button', { name: 'Copy file path' }).click();
      await expect(fileRow.getByText('file path copied.')).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('part 01.stl');

      const downloadEvent = page.waitForEvent('download');
      await fileRow.getByRole('link', { name: 'Download', exact: true }).click();
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toBe('part 01.stl');
      expect(await readFile(await download.path()!, 'utf8')).toContain('solid tray');

      const first = await submit(page, 'part 01.stl', `queue first ${suffix}`);
      await page.getByRole('button', { name: 'Requests' }).click();
      await expect(page.locator('.request-card').filter({ hasText: `Request ${first}` })).toBeVisible();
      await openProject(page);
      const second = await submit(page, 'part 02.stl', `queue second ${suffix}`);
      await openProject(page);
      const declined = await submit(page, 'part 01.stl', `decline ${suffix}`);
      await openProject(page);
      const canceled = await submit(page, 'part 02.stl', `cancel ${suffix}`);
      await page.getByRole('button', { name: 'Requests' }).click();
      const canceledCard = page.locator('.request-card').filter({ hasText: `Request ${canceled}` });
      await canceledCard.getByRole('button', { name: 'Cancel request' }).click();
      await expect(canceledCard.getByText('Canceled', { exact: true })).toBeVisible();

      const operatorPage = await operator.newPage();
      await signIn(operatorPage, 'syntheticoperator');
      await expect(operatorPage.getByRole('button', { name: 'Queue' })).toBeVisible();
      await operatorPage.getByRole('button', { name: 'Queue' }).click();
      const firstCard = operatorPage.locator('.request-card').filter({ hasText: `Request ${first}` });
      const secondCard = operatorPage.locator('.request-card').filter({ hasText: `Request ${second}` });
      const declinedCard = operatorPage.locator('.request-card').filter({ hasText: `Request ${declined}` });
      await firstCard.getByLabel('Operator note').fill('Ready for slicing');
      await firstCard.getByRole('button', { name: 'Approve and queue' }).click();
      await expect(firstCard.getByText('Queued', { exact: true })).toBeVisible();
      await secondCard.getByRole('button', { name: 'Approve and queue' }).click();
      await expect(secondCard.getByText('Queued', { exact: true })).toBeVisible();
      await declinedCard.getByRole('button', { name: 'Decline' }).click();
      await expect(declinedCard.getByText('Declined', { exact: true })).toBeVisible();

      await operatorPage.getByRole('button', { name: `Move ${second} earlier` }).click();
      await operatorPage.getByRole('button', { name: 'Save queue order' }).click();
      await expect(operatorPage.getByText('Queue order saved.')).toBeVisible();
      const order = await operator.request.get(new URL('/api/requests/queue', baseURL).href);
      expect(order.status()).toBe(200);
      const queue = await order.json() as { items: Array<{ id: string }> };
      const secondPosition = queue.items.findIndex((item) => item.id === second);
      const firstPosition = queue.items.findIndex((item) => item.id === first);
      expect(firstPosition).toBeGreaterThanOrEqual(0);
      expect(secondPosition).toBeGreaterThanOrEqual(0);
      expect(secondPosition).toBeLessThan(firstPosition);
      await secondCard.getByRole('button', { name: 'Choose next' }).click();
      await expect(secondCard.getByRole('button', { name: 'Mark printing' })).toBeVisible();
      await secondCard.getByRole('button', { name: 'Mark printing' }).click();
      await expect(secondCard.getByText('Printing', { exact: true })).toBeVisible();
      await secondCard.getByRole('button', { name: 'Mark completed' }).click();
      await expect(secondCard.getByText('Completed', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Refresh' }).click();
      const finishedCard = page.locator('.request-card').filter({ hasText: `Request ${second}` });
      await expect(finishedCard.getByText('Completed', { exact: true })).toBeVisible();
      const selectedDownload = finishedCard.getByRole('link', { name: 'Download version' });
      await expect(selectedDownload).toHaveAttribute('href', /versionId=/);
      const exactHref = await selectedDownload.getAttribute('href');
      const exactVersion = await requester.request.get(new URL(exactHref!, baseURL).href);
      expect(exactVersion.status()).toBe(200);
      expect(await exactVersion.text()).toContain('solid tray');
      await finishedCard.getByText('Request history').click();
      await expect(finishedCard.getByText('by syntheticoperator').last()).toBeVisible();
      await expect(page.locator('.request-card').filter({ hasText: `Request ${declined}` })
        .getByText('Declined', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await operatorPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('requester.png') });
      await operatorPage.screenshot({ path: testInfo.outputPath('operator.png') });
    } finally {
      await requester.close();
      await operator.close();
    }
  });
}

test('missing exact version remains visible without substituting a file', async ({ browser }, testInfo) => {
  const resolvedRoot = await realpath(libraryRoot!);
  if (!resolvedRoot.includes('/.copilot/session-state/') &&
    !resolvedRoot.startsWith(`${join(tmpdir(), 'print-pantry-e2e-')}`)) {
    throw new Error('Refusing to modify a library outside a dedicated synthetic fixture directory');
  }
  const original = join(resolvedRoot, 'Household', 'Organizers', 'Desk Tray', 'files', 'part 02.stl');
  const expected = [
    'solid tray', 'facet normal 0 0 1', 'outer loop',
    'vertex 0 0 0', 'vertex 10 0 0', 'vertex 0 10 0',
    'endloop', 'endfacet', 'endsolid tray', '',
  ].join('\n');
  const info = await lstat(original);
  if (!info.isFile() || info.isSymbolicLink() || await readFile(original, 'utf8') !== expected) {
    throw new Error('Refusing to move a file that is not the generated test STL');
  }
  const staged = testInfo.outputPath('held-synthetic-part.stl');
  const requester = await createRequesterContext(browser, false);
  const operator = await browser.newContext({ baseURL });
  let moved = false;
  try {
    const page = await requester.newPage();
    await signIn(page, 'syntheticrequester');
    await openProject(page);
    const id = await submit(page, 'part 02.stl', `source unavailable ${Date.now()}`);
    const details = await (await requester.request.get(`/api/requests/${id}`)).json() as {
      request: { selected: Array<{ assetId: string; versionId: string }> };
    };
    const selected = details.request.selected[0];
    const operatorPage = await operator.newPage();
    await signIn(operatorPage, 'syntheticoperator');

    await rename(original, staged);
    moved = true;
    await rescan(operator);
    await page.getByRole('button', { name: 'Requests' }).click();
    const card = page.locator('.request-card').filter({ hasText: `Request ${id}` });
    await expect(card.getByText('The selected source file is no longer available.')).toBeVisible();
    await expect(card.getByText('Exact version unavailable')).toBeVisible();
    const version = `/api/catalog/assets/${selected.assetId}/download?versionId=${selected.versionId}`;
    expect((await requester.request.get(version)).status()).toBe(410);
    await page.screenshot({ path: testInfo.outputPath('source-unavailable.png') });

    await rename(staged, original);
    moved = false;
    await rescan(operator);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(card.getByRole('link', { name: 'Download version' })).toBeVisible();
    expect((await requester.request.get(version)).status()).toBe(200);
  } finally {
    if (moved) {
      await rename(staged, original);
      await rescan(operator);
    }
    await requester.close();
    await operator.close();
  }
});
