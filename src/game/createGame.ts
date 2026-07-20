import Phaser from 'phaser';

import { DISPLAY_DENSITY } from './display';
import { FactoryScene } from './FactoryScene';

export function createFactoryGame(parent: string | HTMLElement): Phaser.Game {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: '#f4f5f1',
    transparent: false,
    render: {
      antialias: true,
      pixelArt: false,
      roundPixels: false,
      powerPreference: 'high-performance',
    },
    scale: {
      mode: Phaser.Scale.NONE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: Math.round(window.innerWidth * DISPLAY_DENSITY),
      height: Math.round(window.innerHeight * DISPLAY_DENSITY),
      zoom: 1 / DISPLAY_DENSITY,
    },
    fps: {
      target: 60,
      min: 30,
      smoothStep: true,
    },
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
    scene: [FactoryScene],
    input: {
      mouse: {
        preventDefaultWheel: true,
      },
    },
    disableContextMenu: true,
  });

  const resize = (): void => {
    game.scale.resize(
      Math.round(window.innerWidth * DISPLAY_DENSITY),
      Math.round(window.innerHeight * DISPLAY_DENSITY),
    );
  };
  window.addEventListener('resize', resize);
  game.events.once(Phaser.Core.Events.DESTROY, () => window.removeEventListener('resize', resize));

  return game;
}
