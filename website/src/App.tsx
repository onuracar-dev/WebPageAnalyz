import { useEffect } from 'react';
import Lenis from 'lenis';
import ProductSite from './ProductSite';

function App() {
  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let lenis: Lenis | null = null;
    let frame = 0;

    const stop = () => {
      window.cancelAnimationFrame(frame);
      frame = 0;
      lenis?.destroy();
      lenis = null;
    };

    const sync = () => {
      stop();
      if (reducedMotion.matches) return;

      const instance = new Lenis({
        autoRaf: false,
        anchors: { offset: -92, duration: 1.05 },
        duration: 1.12,
        easing: (value) => Math.min(1, 1.001 - 2 ** (-10 * value)),
        smoothWheel: true,
        syncTouch: false,
        wheelMultiplier: 0.92,
      });

      lenis = instance;
      const update = (time: number) => {
        if (lenis !== instance) return;
        instance.raf(time);
        frame = window.requestAnimationFrame(update);
      };
      frame = window.requestAnimationFrame(update);
    };

    const scrollToTarget = (event: Event) => {
      const target = (event as CustomEvent<string>).detail;
      if (!target) return;
      if (lenis) {
        lenis.scrollTo(target, { offset: -92, duration: 1.05 });
        return;
      }
      document.querySelector(target)?.scrollIntoView({ block: 'start' });
    };

    sync();
    reducedMotion.addEventListener('change', sync);
    window.addEventListener('wpa:scroll-to', scrollToTarget);
    return () => {
      reducedMotion.removeEventListener('change', sync);
      window.removeEventListener('wpa:scroll-to', scrollToTarget);
      stop();
    };
  }, []);

  return <ProductSite />;
}

export default App;
