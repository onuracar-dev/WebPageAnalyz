import { useId } from 'react';

type Branch = { d: string; width: number; opacity: number };
type RootFibre = { d: string; width: number; opacity: number };

const ROOT_ROUTE = 'M 1035 -140 C 1032 90 980 236 818 405 C 645 584 286 615 252 842 C 218 1070 708 1084 868 1276 C 1032 1470 744 1635 505 1768 C 252 1908 402 2160 704 2280 C 1010 2400 1136 2550 1042 2808 C 944 3072 586 3134 520 3388 C 458 3626 748 3786 808 4022 C 866 4250 812 4470 806 4688 C 800 4925 918 5128 1034 5360';

function seeded(seed: number) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function buildCrown() {
  const random = seeded(4519);
  const branches: Branch[] = [];

  function grow(x: number, y: number, length: number, angle: number, depth: number) {
    if (depth <= 0 || length < 6) return;
    const bend = (random() - .5) * .44;
    const endAngle = angle + bend;
    const endX = x + Math.cos(endAngle) * length;
    const endY = y + Math.sin(endAngle) * length;
    const normalX = Math.cos(endAngle + Math.PI / 2) * length * (random() - .5) * .24;
    const normalY = Math.sin(endAngle + Math.PI / 2) * length * (random() - .5) * .24;
    const c1x = x + Math.cos(angle) * length * .33 + normalX;
    const c1y = y + Math.sin(angle) * length * .33 + normalY;
    const c2x = x + Math.cos(endAngle) * length * .7 - normalX * .4;
    const c2y = y + Math.sin(endAngle) * length * .7 - normalY * .4;
    branches.push({
      d: `M ${x.toFixed(1)} ${y.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)}`,
      width: Math.max(.55, depth * .72),
      opacity: .42 + depth * .075,
    });
    const shrink = .68 + random() * .07;
    grow(endX, endY, length * shrink, endAngle - (.28 + random() * .28), depth - 1);
    grow(endX, endY, length * shrink * (.92 + random() * .08), endAngle + (.28 + random() * .28), depth - 1);
    if (depth > 3 && random() > .58) grow(endX, endY, length * shrink * .82, endAngle + (random() - .5) * .22, depth - 2);
  }

  grow(505, 372, 132, -2.54, 7);
  grow(500, 350, 148, -1.92, 7);
  grow(500, 337, 158, -1.47, 7);
  grow(506, 354, 145, -.98, 7);
  grow(514, 378, 126, -.54, 7);
  return branches;
}

function buildRoots() {
  const random = seeded(8197);
  const roots: RootFibre[] = [];
  for (let index = 0; index < 31; index += 1) {
    const t = index / 30;
    const angle = .18 + t * 2.78 + (random() - .5) * .18;
    const length = 230 + random() * 255;
    const startX = 500 + (random() - .5) * 34;
    const startY = 585 + random() * 24;
    const endX = startX + Math.cos(angle) * length;
    const endY = startY + Math.sin(angle) * length * .62 + 82;
    const c1x = startX + Math.cos(angle) * length * .27 + (random() - .5) * 42;
    const c1y = startY + 72 + random() * 72;
    const c2x = startX + Math.cos(angle) * length * .68 + (random() - .5) * 72;
    const c2y = endY - 78 - random() * 80;
    roots.push({
      d: `M ${startX.toFixed(1)} ${startY.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)}`,
      width: index === 22 ? 8 : 1 + random() * 4.6,
      opacity: index === 22 ? .9 : .25 + random() * .55,
    });
  }
  return roots;
}

const crown = buildCrown();
const roots = buildRoots();

function buildStipple() {
  const random = seeded(120826);
  return Array.from({ length: 920 }, (_, index) => {
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random());
    const edgeNoise = .78 + random() * .38;
    const x = 500 + Math.cos(angle) * radius * 365 * edgeNoise;
    const y = 225 + Math.sin(angle) * radius * 194 * edgeNoise - Math.abs(Math.cos(angle)) * 18;
    return { x, y, radius: .42 + Math.pow(random(), 2.4) * 2.2, opacity: .18 + random() * .58, key: index };
  });
}

function buildSoilDust() {
  const random = seeded(6543);
  return Array.from({ length: 240 }, (_, index) => ({
    x: 500 + (random() - .5) * 770,
    y: 602 + (random() - .5) * 70,
    radius: .35 + random() * 1.45,
    opacity: .12 + random() * .32,
    key: index,
  }));
}

const stipple = buildStipple();
const soilDust = buildSoilDust();

function TreeDrawing({ variant = 'hero' }: { variant?: 'hero' | 'finale' }) {
  const filterId = useId().replace(/:/g, '');
  const isFinale = variant === 'finale';
  return <g className={`vector-tree vector-tree--${variant}`}>
    <defs>
      <linearGradient id={`${filterId}-trunk`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#080807" />
        <stop offset=".5" stopColor="#26231f" />
        <stop offset="1" stopColor="#050505" />
      </linearGradient>
      <filter id={`${filterId}-rough`} x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency=".028" numOctaves="2" seed="7" result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale={isFinale ? 2.4 : 1.7} />
      </filter>
    </defs>
    <ellipse className="vector-tree__ground" cx="500" cy="596" rx="345" ry="22" />
    <g className="vector-tree__crown">
      {crown.map((branch, index) => <path key={index} d={branch.d} style={{ strokeWidth: branch.width, opacity: branch.opacity }} />)}
    </g>
    <g className="vector-tree__stipple">
      {stipple.map((dot) => <circle key={dot.key} cx={dot.x} cy={dot.y} r={dot.radius} style={{ opacity: dot.opacity }} />)}
    </g>
    <path className="vector-tree__trunk" filter={`url(#${filterId}-rough)`} fill={`url(#${filterId}-trunk)`} d="M455 603 C468 546 474 486 477 425 C479 389 472 355 468 321 C486 337 496 359 501 385 C507 344 516 304 535 268 C527 318 529 364 523 405 C535 375 552 350 577 326 C555 363 540 399 535 442 C529 492 538 548 555 603 C529 620 482 621 455 603 Z" />
    <g className="vector-tree__bark">
      <path d="M477 590 C492 530 489 457 500 392" />
      <path d="M512 594 C501 536 513 466 522 409" />
      <path d="M492 588 C512 520 505 452 510 382" />
    </g>
    <g className="vector-tree__roots">
      {roots.map((root, index) => <path key={index} d={root.d} style={{ strokeWidth: root.width, opacity: root.opacity }} />)}
    </g>
    <g className="vector-tree__soil-dust">
      {soilDust.map((dot) => <circle key={dot.key} cx={dot.x} cy={dot.y} r={dot.radius} style={{ opacity: dot.opacity }} />)}
    </g>
  </g>;
}

export function HeroRootTree() {
  return <img
    className="hero-tree"
    src="/assets/reference-tree-hero.svg"
    alt="A mature tree whose exposed roots continue beneath the page"
    width="1600"
    height="1000"
    decoding="async"
    fetchPriority="high"
  />;
}

const fibres = [
  'M 1018 -140 C 1014 96 960 222 800 390 C 626 574 268 594 234 836 C 200 1080 694 1108 852 1290 C 1018 1482 728 1620 488 1750 C 224 1894 382 2178 688 2300 C 984 2418 1118 2558 1020 2818 C 920 3088 568 3112 498 3378 C 432 3632 730 3800 786 4034 C 842 4262 790 4468 784 4690 C 778 4928 900 5144 1016 5370',
  'M 1055 -138 C 1052 86 998 248 836 420 C 658 606 306 632 274 850 C 242 1050 724 1064 886 1260 C 1054 1462 760 1650 522 1786 C 278 1924 422 2142 718 2260 C 1030 2384 1154 2538 1062 2798 C 970 3054 604 3150 542 3398 C 482 3620 766 3774 828 4010 C 888 4240 834 4474 830 4686 C 826 4914 938 5112 1052 5350',
  'M 994 -132 C 990 70 944 208 786 374 C 606 562 244 588 210 826 C 176 1094 680 1134 834 1306 C 998 1490 704 1598 468 1738 C 194 1900 354 2202 666 2324 C 958 2438 1098 2580 998 2834 C 894 3100 548 3088 478 3362 C 410 3638 706 3820 764 4048 C 820 4270 770 4462 762 4692 C 754 4940 876 5160 992 5386',
];

export function JourneyRootWorld() {
  return <svg className="root-map" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <filter id="root-map-soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9" /></filter>
      <radialGradient id="root-map-node" cx="50%" cy="50%" r="50%"><stop offset="0" stopColor="#a43d28" /><stop offset=".34" stopColor="#a43d28" stopOpacity=".34" /><stop offset="1" stopColor="#a43d28" stopOpacity="0" /></radialGradient>
    </defs>
    <g className="root-map__camera">
      <path className="root-map__halo" d={ROOT_ROUTE} />
      <path className="root-map__route-base" d={ROOT_ROUTE} />
      {fibres.map((fibre, index) => <path className="root-map__fibre" d={fibre} key={index} />)}

      <g className="root-map__final-tree" transform="translate(530 4762) scale(1.01)">
        <TreeDrawing variant="finale" />
      </g>

      <path className="root-map__route-progress" data-root-route d={ROOT_ROUTE} />
      <g className="root-map__cursor"><circle className="root-map__cursor-glow" r="64" /><circle className="root-map__cursor-ring" r="19" /><circle className="root-map__cursor-core" r="6" /></g>
    </g>
  </svg>;
}

export function MobileRootRail() {
  return <svg className="mobile-root-rail" viewBox="0 0 80 1000" preserveAspectRatio="none" aria-hidden="true">
    <path className="mobile-root-rail__shadow" d="M42 -20 C42 118 18 182 42 286 C67 392 12 463 40 580 C68 696 19 760 40 1020" />
    <path className="mobile-root-rail__main" d="M42 -20 C42 118 18 182 42 286 C67 392 12 463 40 580 C68 696 19 760 40 1020" />
    <path d="M42 286 C60 278 70 265 78 250" />
    <path d="M40 580 C20 574 9 560 1 542" />
    <path d="M40 815 C58 804 69 788 78 766" />
    {[105, 286, 580, 815].map((y) => <g transform={`translate(42 ${y})`} key={y}><circle r="8" /><circle r="2.5" /></g>)}
  </svg>;
}
