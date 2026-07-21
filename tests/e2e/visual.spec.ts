import { expect, test } from '@playwright/test';

test('renderiza o canvas nítido em 1920×1080 HiDPI sem overflow', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#menu-title')).toBeVisible();
  await page.waitForFunction(() => Boolean(window.__FACTORY_DEBUG__));

  const dimensions = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) throw new Error('Canvas não encontrado');
    const bounds = canvas.getBoundingClientRect();
    return {
      bitmapWidth: canvas.width,
      bitmapHeight: canvas.height,
      cssWidth: Math.round(bounds.width),
      cssHeight: Math.round(bounds.height),
      density: Math.min(window.devicePixelRatio || 1, 2),
      bodyOverflows:
        document.body.scrollWidth > document.documentElement.clientWidth ||
        document.body.scrollHeight > document.documentElement.clientHeight,
    };
  });

  expect(dimensions.bitmapWidth).toBe(Math.round(dimensions.cssWidth * dimensions.density));
  expect(dimensions.bitmapHeight).toBe(Math.round(dimensions.cssHeight * dimensions.density));
  expect(dimensions.bodyOverflows).toBe(false);

  await page.locator('[data-action="menu-play"]').click();
  await expect(page.locator('[data-menu-panel="play"]')).not.toHaveClass(/is-hidden/);
  await page.locator('[data-start-sandbox]').click();
  await page.locator('[data-tool="conveyor"]').click();
  const canvasBounds = await page.locator('#game-container canvas').boundingBox();
  if (!canvasBounds) throw new Error('Canvas sem dimensões');
  await page.mouse.click(
    canvasBounds.x + canvasBounds.width * 0.5,
    canvasBounds.y + canvasBounds.height * 0.45,
  );
  await expect(page.locator('#selection-panel')).toHaveCount(0);
  await expect(page.locator('[data-action="delete"]')).toBeEnabled();
});
