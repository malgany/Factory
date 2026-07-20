export const DISPLAY_DENSITY = Math.min(
  typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
  2,
);

export function toCameraZoom(logicalZoom: number): number {
  return logicalZoom * DISPLAY_DENSITY;
}

export function fromCameraZoom(cameraZoom: number): number {
  return cameraZoom / DISPLAY_DENSITY;
}
