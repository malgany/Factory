import { expect, test, type Page } from '@playwright/test';

interface SolutionMachine {
  id: string;
  type: 'tracked-conveyor' | 'spring';
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
  pieces: number;
  elapsedSeconds: number;
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
        pieces: debug.getMachines().filter((machine) => !machine.fixed).length,
        elapsedSeconds: snapshot.metrics.elapsedSeconds,
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
): SolutionMachine => ({
  id,
  type: 'tracked-conveyor',
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
  goal: { deliveries: number; maxLosses: number; pieceBudget: number; timeLimit?: number },
): void {
  expect(result.status, JSON.stringify(result)).toBe('success');
  expect(result.delivered).toBeGreaterThanOrEqual(goal.deliveries);
  expect(result.lost).toBeLessThanOrEqual(goal.maxLosses);
  expect(result.pieces).toBeLessThanOrEqual(goal.pieceBudget);
  if (goal.timeLimit !== undefined) {
    expect(result.elapsedSeconds).toBeLessThanOrEqual(goal.timeLimit);
  }
}

test('1-1 Linha de montagem possui solução e coleta a estrela', async ({ page }) => {
  const layout = [5, 7, 9, 11].map((x, index) =>
    conveyor(`solution-${index + 1}`, x, 6, 0),
  );
  const result = await runSolution(page, 'assembly-line', layout, 25);
  expectSolved(result, { deliveries: 8, maxLosses: 3, pieceBudget: 4 });
  expect(result.collectedStars).toBe(1);
});

test('2-1 Curva de qualidade possui solução e coleta as estrelas', async ({ page }) => {
  const layout = [
    conveyor('solution-1', 4, 6, 27),
    conveyor('solution-2', 6, 7, 27),
    conveyor('solution-3', 8, 8, 27),
    conveyor('solution-4', 10, 9, 27),
    conveyor('solution-5', 12, 10, 27),
    conveyor('solution-6', 14, 11, 27),
  ];
  const result = await runSolution(page, 'quality-curve', layout, 35);
  expectSolved(result, { deliveries: 10, maxLosses: 3, pieceBudget: 6 });
  expect(result.collectedStars).toBe(2);
});

test('3-1 Primeiro salto possui solução com trampolim', async ({ page }) => {
  const layout = [
    spring('solution-1', 3.25, 8, 65),
    conveyor('solution-2', 8.5, 13.5, 0),
    conveyor('solution-3', 10.5, 13.5, 0),
    conveyor('solution-4', 12.5, 13.5, 0),
    conveyor('solution-5', 14, 13.5, 0),
  ];
  const result = await runSolution(page, 'first-jump', layout, 35);
  expectSolved(result, { deliveries: 10, maxLosses: 3, pieceBudget: 5 });
  expect(result.collectedStars).toBe(1);
});

test('4-1 Por cima ou por volta possui solução pelo desvio', async ({ page }) => {
  const layout = [
    conveyor('solution-1', 3, 12, 0),
    conveyor('solution-2', 5, 12, 0),
    conveyor('solution-3', 7, 12, 0),
    conveyor('solution-4', 8.5, 12.5, 27),
    conveyor('solution-5', 10, 13.5, 0),
    conveyor('solution-6', 12, 13.5, 0),
    conveyor('solution-7', 14, 13.5, 0),
    conveyor('solution-8', 16, 13.5, 0),
    conveyor('solution-9', 18, 13.5, 0),
  ];
  const result = await runSolution(page, 'over-or-around', layout, 40);
  expectSolved(result, { deliveries: 12, maxLosses: 3, pieceBudget: 10 });
});

test('5-1 Salto calibrado possui solução pela janela', async ({ page }) => {
  const layout = [
    spring('solution-1', 3.25, 8, 65),
    conveyor('solution-2', 9.5, 13.5, 0),
    conveyor('solution-3', 11.5, 13.5, 0),
    conveyor('solution-4', 13.5, 13.5, 0),
    conveyor('solution-5', 15.5, 13.5, 0),
  ];
  const result = await runSolution(page, 'calibrated-jump', layout, 42);
  expectSolved(result, { deliveries: 12, maxLosses: 2, pieceBudget: 5 });
  expect(result.collectedStars).toBe(1);
});

test('6-1 Rota das estrelas possui uma rota principal segura', async ({ page }) => {
  const layout = [4, 6, 8, 10, 12, 14, 16, 18].map((x, index) =>
    conveyor(`solution-${index + 1}`, x, 13.5, 0),
  );
  const result = await runSolution(page, 'star-route', layout, 40);
  expectSolved(result, { deliveries: 14, maxLosses: 3, pieceBudget: 9 });
  expect(result.collectedStars).toBe(1);
});

test('6-1 Rota das estrelas possui um desvio que coleta os três bônus', async ({ page }) => {
  const layout = [
    spring('solution-1', 3.25, 8, 65),
    ...[8.5, 10.5, 12.5, 14.5, 16.5, 18.5].map((x, index) =>
      conveyor(`solution-${index + 2}`, x, 13.5, 0),
    ),
  ];
  const result = await runSolution(page, 'star-route', layout, 40);
  expectSolved(result, { deliveries: 14, maxLosses: 3, pieceBudget: 9 });
  expect(result.collectedStars).toBe(3);
});

test('7-1 Encontro de linhas possui solução para os dois fluxos', async ({ page }) => {
  const layout = [
    spring('solution-1', 3.25, 8, 65),
    ...[3.5, 5.5, 7.5, 9.5, 11.5, 13.5, 15.5, 17.5].map((x, index) =>
      conveyor(`solution-${index + 2}`, x, 13.5, 0),
    ),
  ];
  const result = await runSolution(page, 'meeting-lines', layout, 40);
  expectSolved(result, { deliveries: 16, maxLosses: 3, pieceBudget: 10 });
});

test('8-1 Ritmo de produção cumpre a cota antes do tempo', async ({ page }) => {
  const layout = [
    spring('solution-1', 3.25, 8, 65),
    ...[3.5, 5.5, 7.5, 9.5, 11.5, 13.5, 15.5, 17.5, 19.5].map((x, index) =>
      conveyor(`solution-${index + 2}`, x, 13.5, 0),
    ),
  ];
  const result = await runSolution(page, 'production-rhythm', layout, 35);
  expectSolved(result, { deliveries: 24, maxLosses: 2, pieceBudget: 11, timeLimit: 35 });
});

test('9-1 Corredores industriais possui solução entre os bloqueios', async ({ page }) => {
  const layout = [
    spring('solution-1', 3.25, 8, 65),
    ...[3.5, 5.5, 7.5, 9.5, 11.5, 13.5, 15.5, 17.5, 19.5, 21.5].map((x, index) =>
      conveyor(`solution-${index + 2}`, x, 14.5, 0),
    ),
  ];
  const result = await runSolution(page, 'industrial-corridors', layout, 42);
  expectSolved(result, { deliveries: 20, maxLosses: 2, pieceBudget: 12, timeLimit: 42 });
});

test('10-1 Inspeção final combina os dois fluxos dentro do prazo', async ({ page }) => {
  const layout = [
    spring('solution-1', 3.25, 8, 65),
    ...[3.5, 5.5, 7.5, 9.5, 11.5, 13.5, 15.5, 17.5, 19.5, 21.5].map((x, index) =>
      conveyor(`solution-${index + 2}`, x, 13.5, 0),
    ),
    conveyor('solution-12', 23, 13.75, 15),
  ];
  const result = await runSolution(page, 'final-inspection', layout, 42);
  expectSolved(result, { deliveries: 25, maxLosses: 1, pieceBudget: 12, timeLimit: 42 });
});
