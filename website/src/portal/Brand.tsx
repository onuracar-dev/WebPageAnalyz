import type { MouseEvent, ReactNode } from 'react';
import { navigate } from './router';

export function BrandMark({ compact = false }: { compact?: boolean }) {
  const goHome = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate('/');
  };
  return <a className={`brand-mark${compact ? ' brand-mark--compact' : ''}`} href="/" onClick={goHome} aria-label="WebPageAnalyz home">
    <span className="brand-mark__icon" aria-hidden="true">
      <svg viewBox="0 0 32 32"><path d="M6 11V7h4M22 7h4v4M26 21v4h-4M10 25H6v-4M11 16h10" /></svg>
    </span>
    <strong className="brand-mark__word">WebPageAnalyz<i /></strong>
  </a>;
}

export function PortalButtonLink({ href, children, className = '' }: { href: string; children: ReactNode; className?: string }) {
  return <a href={href} className={className} onClick={(event) => { event.preventDefault(); navigate(href); }}>{children}</a>;
}
