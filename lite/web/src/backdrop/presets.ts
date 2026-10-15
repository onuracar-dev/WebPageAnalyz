export type SceneId = 'entry' | 'scan' | 'results';

/** The Topography props we animate between scenes. */
export interface TerrainSettings {
  color: string;
  speed: number;
  elevation: number;
  tilt: number;
  glow: number;
  brightness: number;
  fog: number;
  morph: number;
  glitch: number;
  detail: number;
  markers: 'none' | 'plus' | 'dots';
}

export const ACCENT = '#5eead4';

const PRESETS: Record<SceneId, TerrainSettings> = {
  // Calm glide over the land while the visitor reads and types.
  entry: { color: ACCENT, speed: 0.18, elevation: 1.1, tilt: 30, glow: 0.6, brightness: 0.95, fog: 0.4, morph: 0.2, glitch: 0, detail: 0.35, markers: 'plus' },
  // Faster, taller and slightly unstable while the engines run.
  scan: { color: '#9ff5e6', speed: 0.85, elevation: 1.6, tilt: 24, glow: 0.95, brightness: 1.05, fog: 0.3, morph: 0.55, glitch: 0.06, detail: 0.5, markers: 'dots' },
  // Camera tips over into a map view and dims so the findings map reads on top.
  results: { color: ACCENT, speed: 0.06, elevation: 0.55, tilt: 72, glow: 0.4, brightness: 0.42, fog: 0.5, morph: 0.1, glitch: 0, detail: 0.3, markers: 'none' },
};

export function presetFor(scene: SceneId): TerrainSettings {
  return PRESETS[scene];
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? [...value].map((c) => c + c).join('') : value;
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: number[]): string {
  return `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
}

export function mixColor(from: string, to: string, t: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  return rgbToHex(a.map((v, i) => v + (b[i] - v) * t));
}

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Interpolates every numeric setting and the colour; discrete settings switch halfway. */
export function blendSettings(from: TerrainSettings, to: TerrainSettings, t: number): TerrainSettings {
  const k = easeInOut(Math.max(0, Math.min(1, t)));
  const num = (key: keyof TerrainSettings) => (from[key] as number) + ((to[key] as number) - (from[key] as number)) * k;
  return {
    color: mixColor(from.color, to.color, k),
    speed: num('speed'),
    elevation: num('elevation'),
    tilt: num('tilt'),
    glow: num('glow'),
    brightness: num('brightness'),
    fog: num('fog'),
    morph: num('morph'),
    glitch: num('glitch'),
    detail: num('detail'),
    markers: k < 0.5 ? from.markers : to.markers,
  };
}
