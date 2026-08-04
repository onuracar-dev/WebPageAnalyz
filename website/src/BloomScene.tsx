import { useEffect, useRef } from 'react';
import { animate, stagger } from 'animejs';

type BloomSceneProps = {
  reducedMotion?: boolean;
};

export default function BloomScene({ reducedMotion = false }: BloomSceneProps) {
  const sceneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scene = sceneRef.current;
    const hero = scene?.closest<HTMLElement>('.hero');
    const growthLayers = scene ? Array.from(scene.querySelectorAll<HTMLElement>('.bloom-growth')) : [];
    if (!scene || !hero || growthLayers.length === 0) return undefined;

    const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    if (reducedMotion || coarsePointer) {
      scene.dataset.static = 'true';
      return undefined;
    }

    const lens = { x: scene.clientWidth * 0.72, y: scene.clientHeight * 0.48, radius: 0 };
    const target = { x: lens.x, y: lens.y };
    let frame = 0;
    let phase = 0;
    let leaveTimer: number | undefined;
    let radiusAnimation: ReturnType<typeof animate> | undefined;
    let growthAnimation: ReturnType<typeof animate> | undefined;

    const render = () => {
      lens.x += (target.x - lens.x) * 0.105;
      lens.y += (target.y - lens.y) * 0.105;
      phase += 0.013;

      const activity = Math.min(lens.radius / 260, 1);
      const driftX = Math.sin(phase * 0.83) * 12 * activity;
      const driftY = Math.cos(phase * 0.67) * 9 * activity;
      const pulseA = 1 + Math.sin(phase * 1.07) * 0.055;
      const pulseB = 1 + Math.cos(phase * 0.91) * 0.075;
      const radius = lens.radius;

      scene.style.setProperty('--bloom-x-a', `${lens.x + driftX}px`);
      scene.style.setProperty('--bloom-y-a', `${lens.y + driftY}px`);
      scene.style.setProperty('--bloom-rx-a', `${radius * 0.88 * pulseA}px`);
      scene.style.setProperty('--bloom-ry-a', `${radius * 0.61 * pulseB}px`);
      scene.style.setProperty('--bloom-x-b', `${lens.x - radius * 0.31 - driftY * 0.7}px`);
      scene.style.setProperty('--bloom-y-b', `${lens.y + radius * 0.19 + driftX * 0.45}px`);
      scene.style.setProperty('--bloom-rx-b', `${radius * 0.54 * pulseB}px`);
      scene.style.setProperty('--bloom-ry-b', `${radius * 0.43 * pulseA}px`);
      scene.style.setProperty('--bloom-x-c', `${lens.x + radius * 0.34 + driftY * 0.55}px`);
      scene.style.setProperty('--bloom-y-c', `${lens.y - radius * 0.16 - driftX * 0.35}px`);
      scene.style.setProperty('--bloom-rx-c', `${radius * 0.46 * pulseA}px`);
      scene.style.setProperty('--bloom-ry-c', `${radius * 0.58 * pulseB}px`);
      scene.style.setProperty('--bloom-radius', `${lens.radius}px`);
      frame = window.requestAnimationFrame(render);
    };

    const move = (event: PointerEvent) => {
      const bounds = scene.getBoundingClientRect();
      target.x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
      target.y = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top));
    };

    const enter = () => {
      if (leaveTimer) window.clearTimeout(leaveTimer);
      scene.dataset.active = 'true';
      radiusAnimation?.pause();
      growthAnimation?.pause();
      radiusAnimation = animate(lens, {
        radius: 260,
        duration: 1080,
        ease: 'outElastic(1, .72)',
      });
      growthAnimation = animate(growthLayers, {
        opacity: 1,
        scale: 1,
        delay: stagger(105),
        duration: 920,
        ease: 'outElastic(1, .68)',
      });
    };

    const leave = () => {
      scene.dataset.active = 'false';
      if (leaveTimer) window.clearTimeout(leaveTimer);
      leaveTimer = window.setTimeout(() => {
        scene.dataset.active = 'false';
        radiusAnimation?.pause();
        growthAnimation?.pause();
        radiusAnimation = animate(lens, {
          radius: 0,
          duration: 760,
          ease: 'inOutQuart',
        });
        growthAnimation = animate(growthLayers, {
          opacity: 0,
          scale: 0.84,
          delay: stagger(65, { from: 'last' }),
          duration: 610,
          ease: 'inOutQuart',
        });
      }, 260);
    };

    hero.addEventListener('pointermove', move, { passive: true });
    hero.addEventListener('pointerenter', enter);
    hero.addEventListener('pointerleave', leave);
    frame = window.requestAnimationFrame(render);

    return () => {
      hero.removeEventListener('pointermove', move);
      hero.removeEventListener('pointerenter', enter);
      hero.removeEventListener('pointerleave', leave);
      window.cancelAnimationFrame(frame);
      if (leaveTimer) window.clearTimeout(leaveTimer);
      radiusAnimation?.pause();
      growthAnimation?.pause();
    };
  }, [reducedMotion]);

  return (
    <div className="bloom-scene" ref={sceneRef} aria-hidden="true">
      <img className="bloom-scene__base" src="/assets/hero-stone-base.webp" alt="" fetchPriority="high" decoding="async" />
      <img className="bloom-scene__flora-static" src="/assets/hero-stone-bloom.webp" alt="" fetchPriority="high" decoding="async" />
      {[1, 2, 3].map((layer) => (
        <span className={`bloom-growth bloom-growth--${layer}`} key={layer}>
          <img src="/assets/hero-stone-bloom.webp" alt="" decoding="async" />
        </span>
      ))}
    </div>
  );
}
