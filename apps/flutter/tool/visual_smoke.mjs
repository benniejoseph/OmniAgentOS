import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve('.design/flutter-app/screenshots');
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const cases = [
  { name: 'login-light-phone', width: 390, height: 844, scheme: 'light' },
  { name: 'login-dark-phone', width: 390, height: 844, scheme: 'dark' },
  { name: 'login-light-desktop', width: 1440, height: 960, scheme: 'light' },
  { name: 'login-dark-desktop', width: 1440, height: 960, scheme: 'dark' },
];

for (const visualCase of cases) {
  const page = await browser.newPage({
    viewport: { width: visualCase.width, height: visualCase.height },
    colorScheme: visualCase.scheme,
    reducedMotion: 'no-preference',
  });
  const errors = [];
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !message.text().includes('ERR_CONNECTION_REFUSED')
    ) {
      errors.push(message.text());
    }
  });
  await page.goto('http://127.0.0.1:7357', { waitUntil: 'networkidle' });
  await page.locator('flutter-view').waitFor({ timeout: 90_000 });
  await page.waitForTimeout(2_000);
  await page.screenshot({
    path: resolve(output, `${visualCase.name}.png`),
    fullPage: true,
  });
  if (errors.length > 0) {
    throw new Error(`${visualCase.name}: ${errors.join('\n')}`);
  }
  await page.close();
}

await browser.close();
console.log(`Captured ${cases.length} visual smoke screenshots in ${output}`);
