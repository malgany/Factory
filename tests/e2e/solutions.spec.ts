import { expect, test, type Page } from '@playwright/test';

interface SolutionMachine {
  id: string;
  type:
    | 'slow-conveyor'
    | 'tracked-conveyor'
    | 'fast-conveyor'
    | 'spring'
    | 'turbo-spring';
  gridX: number;
  gridY: number;
  angle: number;
  reversed: boolean;
  fixed: false;
}

interface SolutionResult {
  status: string;
  delivered: number;
  lost: number;
  spent: number;
  collectedStars: number;
  trace: Array<{
    time: number;
    boxes: Array<{ x: number; y: number; velocityX: number; velocityY: number }>;
  }>;
}

async function runSolution(
  page: Page,
  contractId: string,
  machines: SolutionMachine[],
  seconds: number,
): Promise<SolutionResult> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__FACTORY_DEBUG__));
  return page.evaluate(
    ({ id, layout, duration }) => {
      const debug = window.__FACTORY_DEBUG__;
      if (!debug) throw new Error('API de debug indisponível');
      debug.startMode('campaign', id);
      debug.setMachines(layout);
      debug.run();
      const trace: SolutionResult['trace'] = [];
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
        spent: snapshot.metrics.spent,
        collectedStars: snapshot.metrics.collectedStars,
        trace,
      };
    },
    { id: contractId, layout: machines, duration: seconds },
  );
}

const conveyor = (
  id: string,
  gridX: number,
  gridY: number,
  angle: number,
  reversed = false,
  type: SolutionMachine['type'] = 'tracked-conveyor',
): SolutionMachine => ({
  id,
  type,
  gridX,
  gridY,
  angle,
  reversed,
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

function expectSolved(
  result: SolutionResult,
  goal: {
    deliveries: number;
    maxLosses?: number;
    minimumStars?: number;
    budgetLimit: number;
    expectedSpend: number;
  },
): void {
  expect(result.status, JSON.stringify(result)).toBe('success');
  expect(result.delivered).toBeGreaterThanOrEqual(goal.deliveries);
  if (goal.maxLosses !== undefined) {
    expect(result.lost).toBeLessThanOrEqual(goal.maxLosses);
  }
  if (goal.minimumStars !== undefined) {
    expect(result.collectedStars).toBeGreaterThanOrEqual(goal.minimumStars);
  }
  expect(result.spent).toBe(goal.expectedSpend);
  expect(result.spent).toBeLessThanOrEqual(goal.budgetLimit);
}

test('1-1 Linha de montagem possui solução dentro do orçamento', async ({ page }) => {
  const layout = [
    conveyor('solution-1', 4.5, 5.25, 5),
    conveyor('solution-2', 6.75, 5.25, 5),
    conveyor('solution-3', 9, 5.25, 5),
  ];
  const result = await runSolution(page, 'assembly-line', layout, 25);
  expectSolved(result, {
    deliveries: 8,
    maxLosses: 0,
    budgetLimit: 8_000,
    expectedSpend: 7_500,
  });
});

test('2-1 Curva de qualidade possui solução dentro do orçamento', async ({ page }) => {
  const layout = [
    conveyor('solution-1', 4, 5.5, 20),
    conveyor('solution-2', 6.75, 7.5, 20),
    conveyor('solution-3', 9.5, 9.5, 20),
    conveyor('solution-4', 12.25, 11.5, 20),
  ];
  const result = await runSolution(page, 'quality-curve', layout, 35);
  expectSolved(result, {
    deliveries: 10,
    maxLosses: 0,
    minimumStars: 2,
    budgetLimit: 10_000,
    expectedSpend: 10_000,
  });
});

test('3-1 Primeiro salto possui solução com trampolim', async ({ page }) => {
  const layout = [spring('solution-1', 1.5, 5.75, 80)];
  const result = await runSolution(page, 'first-jump', layout, 35);
  expectSolved(result, {
    deliveries: 10,
    maxLosses: 0,
    budgetLimit: 5_000,
    expectedSpend: 5_000,
  });
});

test('4-1 Salto calibrado possui solução pela janela', async ({ page }) => {
  const layout = [
    spring('solution-1', 3.5, 8, 45),
    conveyor('solution-2', 19, 13.5, 0, true, 'slow-conveyor'),
    conveyor('solution-3', 21, 13.5, 0, true, 'slow-conveyor'),
    conveyor('solution-4', 23, 13.5, 0, true, 'slow-conveyor'),
  ];
  const result = await runSolution(page, 'calibrated-jump', layout, 42);
  expectSolved(result, {
    deliveries: 12,
    maxLosses: 2,
    minimumStars: 1,
    budgetLimit: 18_000,
    expectedSpend: 11_000,
  });
});

test('6-1 Rota das estrelas possui uma rota completa dentro do orçamento', async ({ page }) => {
  const layout = [
    conveyor('solution-1', 15.75, 10.5, 5, true, 'fast-conveyor'),
    conveyor('solution-2', 12.75, 11, -5, true, 'fast-conveyor'),
    conveyor('solution-3', 10, 12.25, -5, true, 'fast-conveyor'),
    conveyor('solution-4', 7.75, 12.5, 15, true, 'fast-conveyor'),
  ];
  const result = await runSolution(page, 'star-route', layout, 40);
  expectSolved(result, {
    deliveries: 14,
    maxLosses: 0,
    minimumStars: 2,
    budgetLimit: 12_500,
    expectedSpend: 12_000,
  });
});

test('7-1 Por cima ou por volta possui solução pelo salto', async ({ page }) => {
  const layout = [
    conveyor('solution-1', 8, 16.5, 45, false, 'turbo-spring'),
  ];
  const result = await runSolution(page, 'over-or-around', layout, 30);
  expectSolved(result, {
    deliveries: 12,
    maxLosses: 0,
    minimumStars: 1,
    budgetLimit: 25_000,
    expectedSpend: 7_500,
  });
});
