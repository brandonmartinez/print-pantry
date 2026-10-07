import { readFile } from 'node:fs/promises';
import { expect, test, type Browser, type Page } from '@playwright/test';

const baseURL = process.env.PANTRY_E2E_BASE_URL;
const browserPath = process.env.PANTRY_E2E_BROWSER_PATH;
const password = process.env.PANTRY_E2E_PASSWORD;
if (!baseURL || !browserPath || !password || process.env.PANTRY_E2E_SYNTHETIC !== '1' ||
  new URL(baseURL).hostname !== '127.0.0.1') {
  throw new Error('Browser tests require a localhost synthetic app, browser path, and test-only account credentials');
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
      await expect(operatorPage.locator('.queue-list li').first()).toContainText('part 02.stl');
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
