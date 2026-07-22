import { expect, test } from '@playwright/test';

const CONTRACT_IDS = [
  'assembly-line',
  'quality-curve',
  'first-jump',
  'over-or-around',
  'calibrated-jump',
  'star-route',
  'meeting-lines',
  'production-rhythm',
  'industrial-corridors',
  'final-inspection',
] as const;

test('a câmera inicial enquadra os elementos das dez fases', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__FACTORY_DEBUG__));

  for (const contractId of CONTRACT_IDS) {
    await page.evaluate((id) => window.__FACTORY_DEBUG__!.startMode('campaign', id), contractId);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const framing = await page.evaluate(() => {
      const debug = window.__FACTORY_DEBUG__;
      const canvas = document.querySelector('canvas');
      if (!debug || !canvas) throw new Error('Cena ou canvas indisponível');

      const camera = debug.getCamera();
      const viewport = canvas.getBoundingClientRect();
      const left = camera.centerX - viewport.width / camera.zoom / 2;
      const top = camera.centerY - viewport.height / camera.zoom / 2;
      const toScreen = (x: number, y: number) => ({
        x: (x - left) * camera.zoom,
        y: (y - top) * camera.zoom,
      });
      const bounds: Array<{ id: string; left: number; right: number; top: number; bottom: number }> = [];

      for (const machine of debug.getMachines().filter(({ fixed }) => fixed)) {
        const center = toScreen((machine.gridX + 0.5) * 48, (machine.gridY + 0.5) * 48);
        const halfSize = 38 * camera.zoom;
        bounds.push({
          id: machine.id,
          left: center.x - halfSize,
          right: center.x + halfSize,
          top: center.y - halfSize,
          bottom: center.y + halfSize,
        });
      }
      for (const obstacle of debug.getObstacles()) {
        const start = toScreen(obstacle.gridX * 48, obstacle.gridY * 48);
        bounds.push({
          id: obstacle.id,
          left: start.x,
          right: start.x + obstacle.columns * 48 * camera.zoom,
          top: start.y,
          bottom: start.y + obstacle.rows * 48 * camera.zoom,
        });
      }
      for (const collectible of debug.getCollectibles()) {
        const center = toScreen(
          (collectible.gridX + 0.5) * 48,
          (collectible.gridY + 0.5) * 48,
        );
        const radius = 24 * camera.zoom;
        bounds.push({
          id: collectible.id,
          left: center.x - radius,
          right: center.x + radius,
          top: center.y - radius,
          bottom: center.y + radius,
        });
      }
      return { width: viewport.width, height: viewport.height, camera, bounds };
    });

    for (const bounds of framing.bounds) {
      expect(bounds.left, `${contractId}/${bounds.id}`).toBeGreaterThanOrEqual(56);
      expect(
        bounds.right,
        `${contractId}/${bounds.id} ${JSON.stringify(framing.camera)} ${framing.width}×${framing.height}`,
      ).toBeLessThanOrEqual(framing.width - 56);
      expect(bounds.top, `${contractId}/${bounds.id}`).toBeGreaterThanOrEqual(56);
      expect(bounds.bottom, `${contractId}/${bounds.id}`).toBeLessThanOrEqual(
        framing.height - 56,
      );
    }
  }
});
