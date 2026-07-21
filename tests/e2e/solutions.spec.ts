import { expect, test, type Page } from '@playwright/test';

interface SolutionMachine {
  id: string;
  type: 'conveyor' | 'spring';
  gridX: number;
  gridY: number;
  angle: number;
  reversed: boolean;
  fixed: false;
}

async function runSolution(
  page: Page,
  contractId: 'first-flow' | 'controlled-jump' | 'line-rhythm',
  machines: SolutionMachine[],
  seconds: number,
): Promise<{
  status: string;
  delivered: number;
  lost: number;
  pieces: number;
  elapsedSeconds: number;
  trace: Array<{
    time: number;
    boxes: Array<{ x: number; y: number; velocityX: number; velocityY: number }>;
  }>;
}> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__FACTORY_DEBUG__));
  return page.evaluate(
    ({ id, layout, duration }) => {
      const debug = window.__FACTORY_DEBUG__;
      if (!debug) throw new Error('API de debug indisponível');
      debug.startMode('campaign', id);
      debug.setMachines(layout);
      debug.run();
      const trace: Array<{
        time: number;
        boxes: Array<{ x: number; y: number; velocityX: number; velocityY: number }>;
      }> = [];
      let snapshot = debug.getSnapshot();
      for (let time = 2; time <= duration && snapshot.status === 'running'; time += 2) {
        snapshot = debug.advance(Math.min(2, duration - time + 2));
        trace.push({
          time,
          boxes: debug
            .getBoxes()
            .slice(0, 2)
            .map(({ x, y, velocityX, velocityY }) => ({
              x: Math.round(x),
              y: Math.round(y),
              velocityX: Math.round(velocityX * 10) / 10,
              velocityY: Math.round(velocityY * 10) / 10,
            })),
        });
      }
      return {
        status: snapshot.status,
        delivered: snapshot.metrics.delivered,
        lost: snapshot.metrics.lost,
        pieces: debug.getMachines().filter((machine) => !machine.fixed).length,
        elapsedSeconds: snapshot.metrics.elapsedSeconds,
        trace,
      };
    },
    { id: contractId, layout: machines, duration: seconds },
  );
}

const conveyor = (id: string, gridX: number, gridY: number, angle: number): SolutionMachine => ({
  id,
  type: 'conveyor',
  gridX,
  gridY,
  angle,
  reversed: false,
  fixed: false,
});

const spring = (id: string, gridX: number, gridY: number, angle: number): SolutionMachine => ({
  id,
  type: 'spring',
  gridX,
  gridY,
  angle,
  reversed: false,
  fixed: false,
});

test('Primeiro Fluxo possui uma solução física dentro do orçamento', async ({ page }) => {
  const layout = [
    conveyor('solution-1', 4, 6, 27),
    conveyor('solution-2', 6, 7, 27),
    conveyor('solution-3', 8, 8, 27),
    conveyor('solution-4', 10, 9, 27),
    conveyor('solution-5', 12, 10, 27),
    conveyor('solution-6', 14, 11, 27),
  ];

  const result = await runSolution(page, 'first-flow', layout, 35);
  expect(result.status, JSON.stringify(result)).toBe('success');
  expect(result.delivered).toBeGreaterThanOrEqual(10);
  expect(result.lost).toBeLessThanOrEqual(3);
  expect(result.pieces).toBeLessThanOrEqual(8);
});

test('Salto Controlado possui uma solução com trampolim dentro do orçamento', async ({ page }) => {
  const layout = [
    conveyor('solution-1', 4, 6, 0),
    conveyor('solution-2', 6, 6, 0),
    conveyor('solution-3', 8, 6, 0),
    spring('solution-4', 10, 6, 0),
    conveyor('solution-5', 12, 7, 27),
    conveyor('solution-6', 14, 8, 27),
    conveyor('solution-7', 16, 9, 27),
    conveyor('solution-8', 18, 10, 65),
  ];

  const result = await runSolution(page, 'controlled-jump', layout, 40);
  expect(result.status, JSON.stringify(result)).toBe('success');
  expect(result.delivered).toBeGreaterThanOrEqual(12);
  expect(result.lost).toBeLessThanOrEqual(3);
  expect(result.pieces).toBeLessThanOrEqual(8);
});

test('Linha de Ritmo possui uma solução física dentro de 45 segundos', async ({ page }) => {
  const layout = [
    conveyor('solution-1', 3.25, 5.25, 0),
    conveyor('solution-2', 5.25, 5.25, 0),
    spring('solution-3', 7, 5.5, 65),
    conveyor('solution-4', 3.5, 13.5, 0),
    conveyor('solution-5', 5.5, 13.5, 0),
    spring('solution-6', 7.25, 14.25, 50),
    conveyor('solution-7', 15.25, 14.25, 0),
    conveyor('solution-8', 17.25, 14.25, 0),
    conveyor('solution-9', 19.25, 14.25, 0),
    spring('solution-10', 20.5, 14.25, 85),
    conveyor('solution-11', 21.25, 8.75, 0),
    conveyor('solution-12', 18.25, 8.75, 0),
  ];

  const result = await runSolution(page, 'line-rhythm', layout, 45);
  expect(result.status, JSON.stringify(result)).toBe('success');
  expect(result.delivered).toBeGreaterThanOrEqual(25);
  expect(result.lost).toBeLessThanOrEqual(2);
  expect(result.pieces).toBeLessThanOrEqual(12);
  expect(result.elapsedSeconds).toBeLessThanOrEqual(45);
});
