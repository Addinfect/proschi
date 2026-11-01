import { expect, test } from './fixtures';

// Pictures in docs pages and blog posts open enlarged (src/docs/zoom.ts).
test.describe('image zoom', () => {
  test('a docs screenshot opens on click and closes on Escape, giving focus back', async ({ page }) => {
    await page.goto('docs/versions/');
    const shot = page.getByRole('button', { name: /^Enlarge image: The Versions panel/ });
    await shot.click();
    const dialog = page.getByRole('dialog', { name: 'Enlarged image' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.zoom__caption')).toHaveText('Three saved versions of the orders design, newest first.');
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    await expect(page.locator('html')).toHaveClass(/zoom-locked/);
    await expect.poll(() => dialog.locator('img').evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1440);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(shot).toBeFocused();
    await expect(page.locator('html')).not.toHaveClass(/zoom-locked/);
  });

  test('opens from the keyboard, keeps focus inside, and closes on a backdrop click', async ({ page }) => {
    await page.goto('docs/versions/');
    const shot = page.getByRole('button', { name: /^Enlarge image: Comparing 2026-09-14/ });
    await shot.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Enlarged image' });
    await expect(dialog).toBeVisible();
    for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
    }
    await page.mouse.click(8, 300);
    await expect(dialog).toBeHidden();
    await expect(shot).toBeFocused();

    await page.keyboard.press(' ');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    await expect(shot).toBeFocused();
  });

  test('shows a screenshot pixel for pixel when it is bigger than the screen', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 640 });
    await page.goto('docs/versions/');
    await page.getByRole('button', { name: /^Enlarge image: The Versions panel/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Enlarged image' });
    const big = dialog.locator('img');
    const size = dialog.getByRole('button', { name: 'Actual size' });
    await expect(size).toBeVisible();
    await expect(size).toHaveAttribute('aria-pressed', 'false');
    expect(await big.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThan(900);

    await big.click();
    await expect(size).toHaveAttribute('aria-pressed', 'true');
    expect(await big.evaluate((el) => el.getBoundingClientRect().width)).toBe(1440);
    const stage = dialog.locator('.zoom__stage');
    expect(await stage.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // Touch gestures (pinch-zoom) are left to the browser.
    expect(await big.evaluate((el) => getComputedStyle(el).touchAction)).toBe('auto');

    // A mouse drag pans instead of toggling back.
    const box = (await big.boundingBox())!;
    await page.mouse.move(box.x + 400, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 100, { steps: 5 });
    await page.mouse.up();
    expect(await stage.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
    await expect(size).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog).toBeVisible();

    await size.click();
    await expect(size).toHaveAttribute('aria-pressed', 'false');
  });

  test('a picture not loaded yet (loading="lazy") still opens', async ({ page }) => {
    await page.goto('docs/systems/');
    const last = page.locator('.doc-body img.is-zoomable').last();
    expect(await last.evaluate((el: HTMLImageElement) => el.loading)).toBe('lazy');
    await last.evaluate((el: HTMLImageElement) => el.click());
    const big = page.getByRole('dialog', { name: 'Enlarged image' }).locator('img');
    await expect.poll(() => big.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  });

  test('a blog picture opens, and live examples are left alone', async ({ page }) => {
    await page.goto('blog/versions-and-cloud-references/');
    const shot = page.getByRole('button', { name: /^Enlarge image: The compare view/ });
    await shot.click();
    const dialog = page.getByRole('dialog', { name: 'Enlarged image' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.zoom__caption')).toHaveText(/^The compare view/);
    await page.mouse.click(8, 300);
    await expect(dialog).toBeHidden();
    await expect(shot).toBeFocused();

    await page.goto('blog/terminal-diagrams/');
    const example = page.locator('figure[data-live]').first();
    await example.scrollIntoViewIfNeeded();
    await expect.poll(() => example.locator('.react-flow__node').count()).toBe(4);
    await expect(page.locator('figure[data-live] .is-zoomable, figure[data-live] [aria-haspopup="dialog"]')).toHaveCount(0);
  });
});
