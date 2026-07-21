import Phaser from 'phaser';

import factoryBoxTextureUrl from '../assets/factory-box-game.png?url';
import {
  MACHINE_DIMENSIONS,
  MACHINE_PHYSICS_DIMENSIONS,
  degreesToRadians,
  localToWorld,
  rectangleCorners,
  worldToLocal,
  type Point,
} from './geometry';
import { conveyorVelocity, FIXED_PHYSICS_STEP_SECONDS, springVelocity } from './physicsModel';

const STAGE_WIDTH = 256;
const STAGE_HEIGHT = 128;
const MENU_GRID_SIZE = 64;
const BOX_SIZE = 28;
const OFFSCREEN_CLEANUP_MARGIN = BOX_SIZE * 2;
const BOX_TEXTURE_KEY = 'menu-demo-box';
const PHYSICS_SPEED = 0.5;
const FIXED_PHYSICS_STEP_MS = FIXED_PHYSICS_STEP_SECONDS * 1000;
const SPAWN_INTERVAL_MS = 15_000;
const SPRING_ANGLE = 22;
const SPRING_COOLDOWN_MS = 360;
const CONVEYOR_CENTER: Point = { x: 80, y: 52 };
const SPRING_CENTER: Point = { x: 160, y: 98 };

const COLORS = {
  graphite: 0x293139,
  conveyor: 0x40566b,
  springGreen: 0x43a96b,
  wood: 0xb47a48,
  white: 0xffffff,
} as const;

interface MenuBoxRuntime {
  body: MatterJS.BodyType;
  image: Phaser.GameObjects.Image;
  springReadyAt: number;
}

interface MenuDemoRenderSize {
  width: number;
  height: number;
}

export interface MenuDemoController {
  setActive(active: boolean): void;
  destroy(): void;
}

function drawPolygon(graphics: Phaser.GameObjects.Graphics, points: readonly Point[]): void {
  graphics.fillPoints(
    points.map((point) => new Phaser.Math.Vector2(point.x, point.y)),
    true,
    true,
  );
}

function linePolygon(
  graphics: Phaser.GameObjects.Graphics,
  points: readonly Point[],
  close = true,
): void {
  graphics.strokePoints(
    points.map((point) => new Phaser.Math.Vector2(point.x, point.y)),
    close,
    close,
  );
}

export class MenuDemoScene extends Phaser.Scene {
  private readonly parent: HTMLElement;
  private renderSize: MenuDemoRenderSize;
  private graphics?: Phaser.GameObjects.Graphics;
  private springBody?: MatterJS.BodyType;
  private box?: MenuBoxRuntime;
  private requestedActive = true;
  private created = false;
  private physicsAccumulator = 0;
  private simulationTimeMs = 0;
  private simulationVisualTimeMs = 0;
  private lastSpawnWallTime = Number.NEGATIVE_INFINITY;
  private springCompression = 0;
  private visibleTop = 0;
  private destroyedBoxes = 0;
  private offscreenDestroyedBoxes = 0;
  private simulationSteps = 0;

  constructor(parent: HTMLElement, renderSize: MenuDemoRenderSize) {
    super({ key: 'MenuDemoScene' });
    this.parent = parent;
    this.renderSize = renderSize;
  }

  preload(): void {
    this.load.image(BOX_TEXTURE_KEY, factoryBoxTextureUrl);
  }

  create(): void {
    this.matter.set60Hz();
    this.matter.world.autoUpdate = false;
    this.configureCamera();
    this.graphics = this.add.graphics().setDepth(1);
    this.createStaticBodies();
    this.created = true;
    this.renderDemo();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.shutdown, this);
    this.applyActiveState();
  }

  update(_time: number, delta: number): void {
    if (!this.requestedActive || !this.created) return;

    const now = performance.now();
    if (!this.box && now - this.lastSpawnWallTime >= SPAWN_INTERVAL_MS) {
      this.spawnBox(now);
    }

    const scaledDelta = Math.min(delta, 250) * PHYSICS_SPEED;
    this.physicsAccumulator += scaledDelta;
    this.simulationVisualTimeMs += scaledDelta;
    while (this.physicsAccumulator >= FIXED_PHYSICS_STEP_MS && this.requestedActive) {
      this.simulateFixedStep();
      this.physicsAccumulator -= FIXED_PHYSICS_STEP_MS;
    }

    this.springCompression = Math.max(0, this.springCompression - scaledDelta / 170);
    this.renderDemo();
  }

  setDemoActive(active: boolean): void {
    this.requestedActive = active;
    this.parent.dataset.active = String(active);
    if (!this.created) return;
    this.applyActiveState();
  }

  resizeRenderer(renderSize: MenuDemoRenderSize): void {
    this.renderSize = renderSize;
    if (this.created) this.configureCamera();
  }

  private configureCamera(): void {
    const { width, height } = this.renderSize;
    const zoom = width / STAGE_WIDTH;
    const visibleHeight = height / zoom;
    this.visibleTop = STAGE_HEIGHT - visibleHeight;
    this.cameras.main
      .setViewport(0, 0, width, height)
      .setZoom(zoom)
      .centerOn(STAGE_WIDTH / 2, this.visibleTop + visibleHeight / 2);
    this.parent.dataset.backingWidth = String(width);
    this.parent.dataset.backingHeight = String(height);
    this.parent.dataset.visibleTop = this.visibleTop.toFixed(2);
  }

  private applyActiveState(): void {
    if (this.requestedActive) {
      this.physicsAccumulator = 0;
      this.lastSpawnWallTime = Number.NEGATIVE_INFINITY;
      this.scene.resume();
      return;
    }

    this.removeBox('inactive');
    this.physicsAccumulator = 0;
    this.springCompression = 0;
    this.renderDemo();
    this.scene.pause();
  }

  private createStaticBodies(): void {
    const conveyorDimensions = MACHINE_PHYSICS_DIMENSIONS.conveyor;
    this.matter.add.rectangle(
      CONVEYOR_CENTER.x,
      CONVEYOR_CENTER.y,
      conveyorDimensions.width,
      conveyorDimensions.height,
      {
        isStatic: true,
        label: 'menu-demo-conveyor',
        friction: 0.05,
        restitution: 0,
        chamfer: { radius: 3 },
      },
    );

    const springDimensions = MACHINE_PHYSICS_DIMENSIONS.spring;
    this.springBody = this.matter.add.rectangle(
      SPRING_CENTER.x,
      SPRING_CENTER.y,
      springDimensions.width,
      springDimensions.height,
      {
        isStatic: true,
        label: 'menu-demo-spring',
        friction: 0.5,
        restitution: 0.05,
        chamfer: { radius: 3 },
      },
    );
    this.matter.body.setAngle(this.springBody, degreesToRadians(SPRING_ANGLE));
  }

  private spawnBox(now: number): void {
    if (this.box) return;
    // Start fully above the camera viewport so the box visibly falls into the scene.
    // `visibleTop` changes with the menu's aspect ratio, so a fixed world Y can
    // otherwise put part of the box on screen as soon as it is created.
    const spawnY = this.visibleTop - BOX_SIZE;
    const body = this.matter.add.rectangle(50, spawnY, BOX_SIZE, BOX_SIZE, {
      label: 'menu-demo-factory-box',
      restitution: 0.08,
      friction: 0.24,
      frictionStatic: 0.45,
      frictionAir: 0.002,
      density: 0.002,
      chamfer: { radius: 3 },
    });
    this.matter.body.setVelocity(body, { x: 0, y: 0.7 });
    const image = this.add.image(body.position.x, body.position.y, BOX_TEXTURE_KEY).setDepth(2);
    this.box = { body, image, springReadyAt: 0 };
    this.lastSpawnWallTime = now;
    this.parent.dataset.activeBoxes = '1';
  }

  private simulateFixedStep(): void {
    this.simulationTimeMs += FIXED_PHYSICS_STEP_MS;
    this.updateConveyor();
    this.matter.world.step(FIXED_PHYSICS_STEP_MS);
    this.updateSpring();
    this.removeBoxWhenOffscreen();
    this.simulationSteps += 1;
    this.parent.dataset.simulationSteps = String(this.simulationSteps);
  }

  private updateConveyor(): void {
    const box = this.box;
    if (!box) return;
    const local = worldToLocal(CONVEYOR_CENTER, 0, box.body.position);
    const dimensions = MACHINE_PHYSICS_DIMENSIONS.conveyor;
    if (
      Math.abs(local.x) > dimensions.width / 2 + BOX_SIZE / 2 ||
      local.y < -BOX_SIZE - dimensions.height / 2 ||
      local.y > dimensions.height / 2 + 5
    ) {
      return;
    }
    this.matter.body.setVelocity(box.body, conveyorVelocity(box.body.velocity, 0, false));
  }

  private updateSpring(): void {
    const box = this.box;
    if (!box || this.simulationTimeMs < box.springReadyAt) return;
    const local = worldToLocal(SPRING_CENTER, SPRING_ANGLE, box.body.position);
    const dimensions = MACHINE_DIMENSIONS.spring;
    if (
      Math.abs(local.x) > dimensions.width / 2 + BOX_SIZE / 2 ||
      local.y < -BOX_SIZE - dimensions.height / 2 ||
      local.y > dimensions.height / 2 + 5
    ) {
      return;
    }

    const radians = degreesToRadians(SPRING_ANGLE);
    const up = { x: Math.sin(radians), y: -Math.cos(radians) };
    const approachSpeed = box.body.velocity.x * up.x + box.body.velocity.y * up.y;
    if (approachSpeed > 1.5) return;
    this.matter.body.setVelocity(box.body, springVelocity(box.body.velocity, SPRING_ANGLE));
    box.springReadyAt = this.simulationTimeMs + SPRING_COOLDOWN_MS;
    this.springCompression = 1;
  }

  private removeBoxWhenOffscreen(): void {
    const box = this.box;
    if (!box) return;
    const { x, y } = box.body.position;
    let side: 'left' | 'right' | 'top' | 'bottom' | undefined;
    if (x < -OFFSCREEN_CLEANUP_MARGIN) side = 'left';
    else if (x > STAGE_WIDTH + OFFSCREEN_CLEANUP_MARGIN) side = 'right';
    else if (y < this.visibleTop - OFFSCREEN_CLEANUP_MARGIN) side = 'top';
    else if (y > STAGE_HEIGHT + OFFSCREEN_CLEANUP_MARGIN) side = 'bottom';
    if (!side) return;
    this.parent.dataset.lastOffscreenSide = side;
    this.parent.dataset.lastOffscreenX = x.toFixed(2);
    this.parent.dataset.lastOffscreenY = y.toFixed(2);
    this.removeBox('offscreen');
  }

  private removeBox(reason: 'inactive' | 'offscreen' | 'shutdown'): void {
    const box = this.box;
    if (!box) return;
    box.image.destroy();
    this.matter.world.remove(box.body, true);
    this.box = undefined;
    this.destroyedBoxes += 1;
    if (reason === 'offscreen') this.offscreenDestroyedBoxes += 1;
    this.parent.dataset.activeBoxes = '0';
    this.parent.dataset.destroyedBoxes = String(this.destroyedBoxes);
    this.parent.dataset.offscreenDestroyedBoxes = String(this.offscreenDestroyedBoxes);
  }

  private renderDemo(): void {
    const graphics = this.graphics;
    if (!graphics) return;
    graphics.clear();
    this.drawConveyor(graphics);
    this.drawSpring(graphics);

    const box = this.box;
    if (!box) return;
    box.image
      .setPosition(box.body.position.x, box.body.position.y)
      .setRotation(box.body.angle)
      .setDisplaySize(BOX_SIZE, BOX_SIZE);
  }

  private drawConveyor(graphics: Phaser.GameObjects.Graphics): void {
    const dimensions = MACHINE_DIMENSIONS.conveyor;
    graphics.fillStyle(COLORS.conveyor, 1);
    drawPolygon(graphics, rectangleCorners(CONVEYOR_CENTER, dimensions.width, dimensions.height));
    graphics.lineStyle(2, COLORS.graphite, 0.55);
    linePolygon(graphics, rectangleCorners(CONVEYOR_CENTER, dimensions.width, dimensions.height));

    const phase = (((this.simulationVisualTimeMs * 0.055) % 24) + 24) % 24;
    graphics.fillStyle(COLORS.white, 0.94);
    for (let offset = -60 + phase; offset <= 60; offset += 24) {
      if (Math.abs(offset) > dimensions.width / 2 - 7) continue;
      const tip = localToWorld(CONVEYOR_CENTER, 0, offset + 6, 0);
      const upper = localToWorld(CONVEYOR_CENTER, 0, offset - 5, -7);
      const lower = localToWorld(CONVEYOR_CENTER, 0, offset - 5, 7);
      drawPolygon(graphics, [tip, upper, lower]);
    }
  }

  private drawSpring(graphics: Phaser.GameObjects.Graphics): void {
    const dimensions = MACHINE_DIMENSIONS.spring;
    const plateHeight = 8;
    const baseY = dimensions.height / 2 - plateHeight / 2;
    const topY = -dimensions.height / 2 + plateHeight / 2 + this.springCompression * 7;
    const lowerSpringY = dimensions.height / 2 - plateHeight;
    const upperSpringY = topY + plateHeight / 2;

    graphics.fillStyle(COLORS.wood, 1);
    drawPolygon(
      graphics,
      rectangleCorners(
        localToWorld(SPRING_CENTER, SPRING_ANGLE, 0, baseY),
        dimensions.width,
        plateHeight,
        SPRING_ANGLE,
      ),
    );
    drawPolygon(
      graphics,
      rectangleCorners(
        localToWorld(SPRING_CENTER, SPRING_ANGLE, 0, topY),
        dimensions.width,
        plateHeight,
        SPRING_ANGLE,
      ),
    );

    const zigzag: Point[] = [];
    const segments = 7;
    for (let index = 0; index <= segments; index += 1) {
      const progress = index / segments;
      const x = -dimensions.width / 2 + 5 + progress * (dimensions.width - 10);
      const y = index % 2 === 0 ? lowerSpringY : upperSpringY;
      zigzag.push(localToWorld(SPRING_CENTER, SPRING_ANGLE, x, y));
    }
    graphics.lineStyle(4, COLORS.springGreen, 1);
    linePolygon(graphics, zigzag, false);
  }

  private shutdown(): void {
    this.removeBox('shutdown');
    this.created = false;
    this.parent.dataset.activeBoxes = '0';
  }
}

function getMenuDemoRenderSize(parent: HTMLElement): MenuDemoRenderSize {
  const bounds = parent.getBoundingClientRect();
  const density = Math.min(Math.max(window.devicePixelRatio || 1, 2), 3);
  return {
    width: Math.max(STAGE_WIDTH, Math.round(bounds.width * density)),
    height: Math.max(STAGE_HEIGHT, Math.round(bounds.height * density)),
  };
}

export function createMenuDemo(parent: HTMLElement): MenuDemoController {
  parent.dataset.physicsSpeed = String(PHYSICS_SPEED);
  parent.dataset.conveyorGridWidth = String(MACHINE_DIMENSIONS.conveyor.width / MENU_GRID_SIZE);
  parent.dataset.springGridWidth = String(MACHINE_DIMENSIONS.spring.width / MENU_GRID_SIZE);
  parent.dataset.boxGridWidth = String(BOX_SIZE / MENU_GRID_SIZE);
  parent.dataset.offscreenCleanupMargin = String(OFFSCREEN_CLEANUP_MARGIN);
  parent.dataset.activeBoxes = '0';
  parent.dataset.destroyedBoxes = '0';
  parent.dataset.offscreenDestroyedBoxes = '0';
  parent.dataset.simulationSteps = '0';

  let renderSize = getMenuDemoRenderSize(parent);
  const scene = new MenuDemoScene(parent, renderSize);
  const game = new Phaser.Game({
    type: Phaser.CANVAS,
    parent,
    width: renderSize.width,
    height: renderSize.height,
    transparent: true,
    backgroundColor: 'rgba(0,0,0,0)',
    render: {
      antialias: true,
      pixelArt: false,
      roundPixels: false,
    },
    fps: {
      target: 60,
      min: 30,
      smoothStep: true,
    },
    audio: { noAudio: true },
    physics: {
      default: 'matter',
      matter: {
        gravity: { x: 0, y: 1.05 },
        enableSleeping: false,
        positionIterations: 8,
        velocityIterations: 6,
        constraintIterations: 3,
        debug: false,
      },
    },
    scene,
  });

  let desiredActive = true;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const narrowViewport = window.matchMedia('(max-width: 640px)');
  const applyActiveState = (): void => {
    scene.setDemoActive(
      desiredActive && !document.hidden && !reducedMotion.matches && !narrowViewport.matches,
    );
  };
  const handleVisibilityChange = (): void => applyActiveState();
  const handleMediaChange = (): void => applyActiveState();
  const resize = (): void => {
    const nextSize = getMenuDemoRenderSize(parent);
    if (nextSize.width === renderSize.width && nextSize.height === renderSize.height) return;
    renderSize = nextSize;
    game.scale.resize(renderSize.width, renderSize.height);
    scene.resizeRenderer(renderSize);
  };
  const resizeObserver = new ResizeObserver(resize);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('resize', resize);
  reducedMotion.addEventListener('change', handleMediaChange);
  narrowViewport.addEventListener('change', handleMediaChange);
  resizeObserver.observe(parent);
  applyActiveState();

  let destroyed = false;
  return {
    setActive(active: boolean): void {
      if (destroyed) return;
      desiredActive = active;
      applyActiveState();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('resize', resize);
      reducedMotion.removeEventListener('change', handleMediaChange);
      narrowViewport.removeEventListener('change', handleMediaChange);
      resizeObserver.disconnect();
      scene.setDemoActive(false);
      game.destroy(true);
    },
  };
}
