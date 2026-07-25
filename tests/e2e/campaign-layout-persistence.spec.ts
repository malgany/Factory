import { expect, test, type Page } from '@playwright/test';

const STORAGE_KEY = 'factory-flow.progress.v1';

type DebugWindow = Window & {
  __FACTORY_DEBUG__?: {
    getMachines(): Array<{ id: string; type: string; fixed: boolean }>;
    placeMachine(type: 'tracked-conveyor', gridX: number, gridY: number): boolean;
  };
};

async function openFirstContract(page: Page): Promise<void> {
  await page.locator('[data-action="menu-play"]').click();
  await expect(page.locator('#menu-screen')).toHaveAttribute('data-menu-view', 'play');
  await expect(page.locator('#menu-screen')).not.toHaveAttribute('data-menu-transitioning', 'true');
  await page.locator('[data-action="campaign-play"]').click();
  await page.waitForFunction(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    return Boolean(debug?.getMachines().length);
  });
}

test('restores the latest campaign construction after leaving or reloading', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#menu-title')).toBeVisible();
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
  await page.reload();
  await expect(page.locator('#menu-title')).toBeVisible();
  await page.waitForFunction(() => Boolean((window as DebugWindow).__FACTORY_DEBUG__));

  await openFirstContract(page);
  const savedMachine = await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug || !debug.placeMachine('tracked-conveyor', 7, 4)) {
      throw new Error('Could not place a campaign conveyor');
    }
    return debug.getMachines().find((machine) => !machine.fixed);
  });
  expect(savedMachine).toBeTruthy();
  const savedMachineId = savedMachine?.id;
  if (!savedMachineId) throw new Error('The placed campaign machine has no id');

  await expect
    .poll(() =>
      page.evaluate((key) => {
        const stored = localStorage.getItem(key);
        return stored
          ? (JSON.parse(stored).campaignLayouts?.['assembly-line']?.machines ?? [])
          : [];
      }, STORAGE_KEY),
    )
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: savedMachineId })]));

  await page.reload();
  await expect(page.locator('#menu-title')).toBeVisible();
  await page.waitForFunction(() => Boolean((window as DebugWindow).__FACTORY_DEBUG__));
  await openFirstContract(page);
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as DebugWindow).__FACTORY_DEBUG__
            ?.getMachines()
            .find((machine) => machine.id === id),
        savedMachineId,
      ),
    )
    .toMatchObject({ id: savedMachineId, type: 'tracked-conveyor', fixed: false });
});
