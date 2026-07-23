import Phaser from 'phaser';

import factoryBoxTextureUrl from '../assets/factory-box-game.png?url';
import {
  MACHINE_DIMENSIONS,
  MACHINE_PHYSICS_DIMENSIONS,
  degreesToRadians,
  localToWorld,
  rectangleCorners,
  type Point,
} from './geometry';
import {
  boxTouchesOrientedSurface,
  FIXED_PHYSICS_STEP_SECONDS,
  springVelocity,
} from './physicsModel';

const STAGE_WIDTH = 256;
const STAGE_HEIGHT = 128;
const MENU_GRID_SIZE = 64;
const BOX_SIZE = 28;
const BOX_TEXTURE_SCALE_X = 1.2;
const BOX_TEXTURE_SCALE_Y = 1.18;
const OFFSCREEN_CLEANUP_MARGIN = BOX_SIZE * 2;
const BOX_TEXTURE_KEY = 'menu-demo-box';
const PHYSICS_SPEED = 0.5;
const FIXED_PHYSICS_STEP_MS = FIXED_PHYSICS_STEP_SECONDS * 1000;
const SPAWN_INTERVAL_MS = 15_000;
const SPRING_ANGLE = 22;
const SPRING_COOLDOWN_MS = 360;
const CONVEYOR_CENTER: Point = { x: 80, y: 52 };
const SPRING_CENTER: Point = { x: 160, y: 98 };
const TRACKED_CONVEYOR_WHEEL_RADIUS = 6.5;
const TRACKED_CONVEYOR_TRACK_RADIUS = 8.5;
const TRACKED_CONVEYOR_LINK_WIDTH = 7.5;
const TRACKED_CONVEYOR_LINK_HEIGHT = 4;
const TRACKED_CONVEYOR_LINK_COUNT = 24;
const TRACKED_CONVEYOR_SPEED = 2.38;
const TRACKED_CONVEYOR_STRAIGHT_LENGTH = 64;
const TRACKED_CONVEYOR_ARC_LENGTH = Math.PI * TRACKED_CONVEYOR_TRACK_RADIUS;
const TRACKED_CONVEYOR_TRACK_LENGTH =
  TRACKED_CONVEYOR_STRAIGHT_LENGTH * 2 + TRACKED_CONVEYOR_ARC_LENGTH * 2;

const COLORS = {
  graphite: 0x293139,
  conveyor: 0x40566b,
  blueLight: 0x82a5c5,
  orange: 0xff7629,
  springGreen: 0x25c442,
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

interface TrackedConveyorPose {
  center: Point;
  angle: number;
}

export interface MenuDemoController {
  setActive(active: boolean): void;
  destroy(): void;
}

function drawPolygon(graphics: Phaser.GameObjects.Graphics, points: readonly Point[]): void {
  const first = points[0];
  if (!first || points.length < 3) return;
  graphics.beginPath();
  graphics.moveTo(first.x, first.y);
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (point) graphics.lineTo(point.x, point.y);
  }
  graphics.closePath();
  graphics.fillPath();
}

function linePolygon(
  graphics: Phaser.GameObjects.Graphics,
  points: readonly Point[],
  close = true,
): void {
  const first = points[0];
  if (!first || points.length < 2) return;
  graphics.beginPath();
  graphics.moveTo(first.x, first.y);
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (point) graphics.lineTo(point.x, point.y);
  }
  if (close) graphics.closePath();
  graphics.strokePath();
}

function trackedConveyorWheelCenters(): Point[] {
  return [-32, 0, 32].map((offsetX) =>
    localToWorld(CONVEYOR_CENTER, 0, offsetX, 0),
  );
}

function trackedConveyorPoseAt(rawDistance: number): TrackedConveyorPose {
  let distance =
    ((rawDistance % TRACKED_CONVEYOR_TRACK_LENGTH) + TRACKED_CONVEYOR_TRACK_LENGTH) %
    TRACKED_CONVEYOR_TRACK_LENGTH;
  let x: number;
  let y: number;
  let tangent: number;

  if (distance < TRACKED_CONVEYOR_STRAIGHT_LENGTH) {
    x = -32 + distance;
    y = -TRACKED_CONVEYOR_TRACK_RADIUS;
    tangent = 0;
  } else if (
    (distance -= TRACKED_CONVEYOR_STRAIGHT_LENGTH) < TRACKED_CONVEYOR_ARC_LENGTH
  ) {
    const polar = -Math.PI / 2 + distance / TRACKED_CONVEYOR_TRACK_RADIUS;
    x = 32 + Math.cos(polar) * TRACKED_CONVEYOR_TRACK_RADIUS;
    y = Math.sin(polar) * TRACKED_CONVEYOR_TRACK_RADIUS;
    tangent = polar + Math.PI / 2;
  } else if ((distance -= TRACKED_CONVEYOR_ARC_LENGTH) < TRACKED_CONVEYOR_STRAIGHT_LENGTH) {
    x = 32 - distance;
    y = TRACKED_CONVEYOR_TRACK_RADIUS;
    tangent = Math.PI;
  } else {
    distance -= TRACKED_CONVEYOR_STRAIGHT_LENGTH;
    const polar = Math.PI / 2 + distance / TRACKED_CONVEYOR_TRACK_RADIUS;
    x = -32 + Math.cos(polar) * TRACKED_CONVEYOR_TRACK_RADIUS;
    y = Math.sin(polar) * TRACKED_CONVEYOR_TRACK_RADIUS;
    tangent = polar + Math.PI / 2;
  }

  return {
    center: localToWorld(CONVEYOR_CENTER, 0, x, y),
    angle: tangent,
  };
}

export class MenuDemoScene extends Phaser.Scene {
  private readonly parent: HTMLElement;
  private renderSize: MenuDemoRenderSize;
  private graphics?: Phaser.GameObjects.Graphics;
  private springBody?: MatterJS.BodyType;
  private readonly trackedWheels: MatterJS.BodyType[] = [];
  private readonly trackedLinks: MatterJS.BodyType[] = [];
  private trackedPhase = 0;
  private box?: MenuBoxRuntime;
  private requestedActive = true;
  private created = false;
  private physicsAccumulator = 0;
  private simulationTimeMs = 0;
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
    for (const [index, center] of trackedConveyorWheelCenters().entries()) {
      this.trackedWheels.push(
        this.matter.add.circle(center.x, center.y, TRACKED_CONVEYOR_WHEEL_RADIUS, {
          isStatic: true,
          label: `menu-demo-tracked-wheel:${index}`,
          friction: 1,
          frictionStatic: 5,
          restitution: 0,
          slop: 0.02,
        }),
      );
    }
    for (let index = 0; index < TRACKED_CONVEYOR_LINK_COUNT; index += 1) {
      const pose = trackedConveyorPoseAt(
        (index * TRACKED_CONVEYOR_TRACK_LENGTH) / TRACKED_CONVEYOR_LINK_COUNT,
      );
      const link = this.matter.add.rectangle(
        pose.center.x,
        pose.center.y,
        TRACKED_CONVEYOR_LINK_WIDTH,
        TRACKED_CONVEYOR_LINK_HEIGHT,
        {
          isStatic: true,
          label: `menu-demo-tracked-link:${index}`,
          friction: 1,
          frictionStatic: 5,
          restitution: 0,
          slop: 0.015,
          chamfer: { radius: 1.2 },
        },
      );
      this.matter.body.setAngle(link, pose.angle);
      this.trackedLinks.push(link);
    }

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
    const body = this.matter.add.rectangle(CONVEYOR_CENTER.x, spawnY, BOX_SIZE, BOX_SIZE, {
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
    this.updateTrackedConveyor();
    this.matter.world.step(FIXED_PHYSICS_STEP_MS);
    this.updateSpring();
    this.removeBoxWhenOffscreen();
    this.simulationSteps += 1;
    this.parent.dataset.simulationSteps = String(this.simulationSteps);
  }

  private updateTrackedConveyor(): void {
    this.trackedPhase =
      (this.trackedPhase + TRACKED_CONVEYOR_SPEED) % TRACKED_CONVEYOR_TRACK_LENGTH;
    for (let index = 0; index < this.trackedLinks.length; index += 1) {
      const link = this.trackedLinks[index]!;
      const pose = trackedConveyorPoseAt(
        (index * TRACKED_CONVEYOR_TRACK_LENGTH) / TRACKED_CONVEYOR_LINK_COUNT +
          this.trackedPhase,
      );
      let targetAngle = pose.angle;
      while (targetAngle - link.angle > Math.PI) targetAngle -= Math.PI * 2;
      while (targetAngle - link.angle < -Math.PI) targetAngle += Math.PI * 2;
      this.matter.body.setPosition(link, pose.center, true);
      this.matter.body.setAngle(link, targetAngle, true);
    }
  }

  private updateSpring(): void {
    const box = this.box;
    if (!box || this.simulationTimeMs < box.springReadyAt) return;
    const dimensions = MACHINE_DIMENSIONS.spring;
    if (!boxTouchesOrientedSurface(
      box.body.position,
      Phaser.Math.RadToDeg(box.body.angle),
      BOX_SIZE,
      SPRING_CENTER,
      SPRING_ANGLE,
      dimensions.width,
      dimensions.height,
    )) {
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
    this.drawTrackedConveyor(graphics);
    this.drawSpring(graphics);

    const box = this.box;
    if (!box) return;
    box.image
      .setPosition(box.body.position.x, box.body.position.y)
      .setRotation(box.body.angle)
      .setDisplaySize(BOX_SIZE * BOX_TEXTURE_SCALE_X, BOX_SIZE * BOX_TEXTURE_SCALE_Y);
  }

  private drawTrackedConveyor(graphics: Phaser.GameObjects.Graphics): void {
    const outlineHeight = TRACKED_CONVEYOR_TRACK_RADIUS * 2 + TRACKED_CONVEYOR_LINK_HEIGHT;
    const outlineWidth =
      TRACKED_CONVEYOR_STRAIGHT_LENGTH +
      TRACKED_CONVEYOR_TRACK_RADIUS * 2 +
      TRACKED_CONVEYOR_LINK_HEIGHT;
    graphics.fillStyle(COLORS.graphite, 1);
    graphics.fillRoundedRect(
      CONVEYOR_CENTER.x - (outlineWidth - 1) / 2,
      CONVEYOR_CENTER.y - (outlineHeight - 1) / 2,
      outlineWidth - 1,
      outlineHeight - 1,
      (outlineHeight - 1) / 2,
    );

    for (const wheel of this.trackedWheels) {
      graphics.fillStyle(COLORS.conveyor, 1);
      graphics.fillCircle(wheel.position.x, wheel.position.y, TRACKED_CONVEYOR_WHEEL_RADIUS);
      graphics.lineStyle(1.5, COLORS.blueLight, 0.95);
      graphics.strokeCircle(wheel.position.x, wheel.position.y, TRACKED_CONVEYOR_WHEEL_RADIUS);
    }

    for (let index = 0; index < this.trackedLinks.length; index += 1) {
      const link = this.trackedLinks[index];
      if (!link) continue;
      const points = link.vertices ?? [];
      if (points.length < 3) continue;
      graphics.fillStyle(index % 2 === 0 ? COLORS.white : COLORS.conveyor, 1);
      drawPolygon(graphics, points);
      graphics.lineStyle(0.8, COLORS.graphite, 0.82);
      linePolygon(graphics, points);
    }

    graphics.fillStyle(COLORS.white, 0.96);
    for (const wheel of this.trackedWheels) {
      drawPolygon(graphics, [
        { x: wheel.position.x + 4, y: wheel.position.y },
        { x: wheel.position.x - 2.5, y: wheel.position.y - 3.4 },
        { x: wheel.position.x - 2.5, y: wheel.position.y + 3.4 },
      ]);
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
  parent.dataset.conveyorGridWidth = String(
    MACHINE_DIMENSIONS['tracked-conveyor'].width / MENU_GRID_SIZE,
  );
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
