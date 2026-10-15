import { useEffect, useRef, useState } from 'react';
import type { Severity } from '../api';
import Topography from '../vendor/react-bits/Topography';
import { blendSettings, presetFor, type SceneId, type TerrainSettings } from './presets';

const TRANSITION_MS = 1600;

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** Tweens the Topography settings whenever the scene (or the results tone) changes. */
function useTweenedSettings(target: TerrainSettings): TerrainSettings {
  const [current, setCurrent] = useState(target);
  const currentRef = useRef(target);
  currentRef.current = current;

  useEffect(() => {
    if (prefersReducedMotion()) {
      setCurrent(target);
      return;
    }
    const from = currentRef.current;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / TRANSITION_MS);
      setCurrent(blendSettings(from, target, t));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return current;
}

interface Props {
  scene: SceneId;
  worst?: Severity;
}

export function TerrainBackdrop({ scene, worst }: Props) {
  const [target, setTarget] = useState(() => presetFor(scene, worst));
  useEffect(() => setTarget(presetFor(scene, worst)), [scene, worst]);
  const settings = useTweenedSettings(target);

  return (
    <div className="backdrop" aria-hidden="true">
      <Topography
        {...settings}
        lineCount={24}
        lineWidth={1.1}
        foreground={0.25}
        depthOfField={0.35}
        hoverEffect="lift"
        clickEffect="pulse"
        mouseStrength={0.5}
        parallax={0.4}
      />
      <div className={`backdrop__shade backdrop__shade--${scene}`} />
    </div>
  );
}
