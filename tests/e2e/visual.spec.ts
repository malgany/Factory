import { expect, test } from '@playwright/test';

test('renderiza o canvas nítido em 1920×1080 HiDPI sem overflow', async ({ page }) => {
  test.setTimeout(45_000);
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

  const menu = page.locator('#menu-screen');
  const options = page.locator('[data-menu-panel="options"]');
  await page.locator('[data-action="menu-options"]').click();
  await expect(menu).toHaveAttribute('data-menu-view', 'options');
  await expect(menu).not.toHaveAttribute('data-menu-transitioning', 'true');
  await expect(options).toHaveAttribute('aria-hidden', 'false');
  const optionsBounds = await options.boundingBox();
  expect(optionsBounds?.x).toBeCloseTo(0, 1);
  expect(optionsBounds?.y).toBeCloseTo(0, 1);
  expect(optionsBounds?.width).toBeCloseTo(1920, 1);
  expect(optionsBounds?.height).toBeCloseTo(1080, 1);
  await expect(options.locator('.options-back-button')).toBeInViewport();
  await expect(options.locator('.options-layout')).toBeInViewport();
  await expect(options.locator('[data-options-tab="audio-video"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const audioCategoryLayout = await options
    .locator('[data-options-tab="audio-video"]')
    .evaluate((button) => {
      const content = document.querySelector<HTMLElement>('.options-content');
      if (!content) throw new Error('Conteúdo das opções não encontrado');
      const buttonBounds = button.getBoundingClientRect();
      const contentBounds = content.getBoundingClientRect();
      return {
        containsText: button.scrollWidth <= button.clientWidth,
        clearsContent: buttonBounds.right < contentBounds.left,
      };
    });
  expect(audioCategoryLayout).toEqual({ containsText: true, clearsContent: true });
  await options.locator('[data-options-tab="controls"]').click();
  await expect(options.locator('[data-options-panel="controls"]')).toBeInViewport();
  await expect(options.locator('.control-device-card')).toHaveCount(2);

  await options.locator('[data-action="menu-home"]').click();
  await expect(menu).toHaveAttribute('data-menu-view', 'home');
  await expect(menu).not.toHaveAttribute('data-menu-transitioning', 'true');
  await page.locator('[data-action="menu-play"]').click();
  await expect(menu).toHaveAttribute('data-menu-view', 'play');
  await expect(menu).not.toHaveAttribute('data-menu-transitioning', 'true');
  await expect(page.locator('.campaign-map-image')).toBeInViewport();
  await page
    .locator('[data-start-sandbox]')
    .evaluate((button: HTMLButtonElement) => button.click());
  const conveyorToolBounds = await page
    .locator('[data-tool="tracked-conveyor"]')
    .boundingBox();
  const canvasBounds = await page.locator('#game-container canvas').boundingBox();
  if (!conveyorToolBounds || !canvasBounds) throw new Error('Hotbar ou canvas sem dimensões');
  await page.mouse.move(
    conveyorToolBounds.x + conveyorToolBounds.width / 2,
    conveyorToolBounds.y + conveyorToolBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    canvasBounds.x + canvasBounds.width * 0.5,
    canvasBounds.y + canvasBounds.height * 0.45,
    { steps: 12 },
  );
  await page.mouse.up();
  await expect(page.locator('#selection-panel')).toHaveCount(0);
  await expect(page.locator('[data-action="delete"]')).toBeEnabled();
});
