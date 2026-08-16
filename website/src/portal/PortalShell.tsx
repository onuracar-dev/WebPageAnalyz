import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Activity, Bell, CheckCircle2, ChevronDown, HelpCircle, LogOut, Menu, Settings, X } from 'lucide-react';
import { gsap } from 'gsap';
import { apiFetch } from './api';
import { BrandMark } from './Brand';
import { navigate } from './router';

export type PortalNavItem = { id: string; label: string; icon: LucideIcon };

type Notification = { id: string; title: string; detail: string; tone?: 'good' | 'warning' };
type UsageAllowance = { limit: number; used: number; remaining: number };
type ProfileUsage = {
  planName: string;
  pageCredits: UsageAllowance;
  aiRemediations: UsageAllowance;
  projects: UsageAllowance;
  sourceAudits: UsageAllowance;
};
type Props = {
  admin?: boolean;
  active: string;
  nav: PortalNavItem[];
  onNavigate: (id: string) => void;
  children: ReactNode;
  footerCard?: ReactNode;
  identity?: { name?: string; email?: string; role?: string } | null;
  profileUsage?: ProfileUsage | null;
  notifications?: Notification[];
};

const FOCUSABLE_SELECTOR = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const ADMIN_DESKTOP_PRIMARY_IDS = new Set(['dashboard', 'users', 'workspaces', 'scans', 'support', 'engine_lab']);

export default function PortalShell({ admin = false, active, nav, onNavigate, children, footerCard, identity, profileUsage = null, notifications = [] }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const [popover, setPopover] = useState<'notifications' | 'help' | 'profile' | null>(null);
  const [notificationsSeen, setNotificationsSeen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);
  const adminMenuRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const popoverTriggerRef = useRef<HTMLElement | null>(null);
  const overlayWasOpenRef = useRef(false);
  const overlayPopoverRef = useRef<typeof popover>(null);
  const overlayAdminMenuRef = useRef(false);
  const sessionRefreshInFlight = useRef(false);
  const overlayReturnRef = useRef<HTMLElement | null>(null);
  const bodyOverflowRef = useRef<string | null>(null);
  const initials = (identity?.name || identity?.email || (admin ? 'Admin' : 'WPA')).split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const activeIndex = Math.max(0, nav.findIndex((item) => item.id === active));
  const primaryNav = admin ? nav : nav.filter((item) => !['status', 'settings'].includes(item.id));
  const desktopPrimaryNav = admin ? primaryNav.filter((item) => ADMIN_DESKTOP_PRIMARY_IDS.has(item.id)) : primaryNav;
  const desktopOverflowNav = admin ? primaryNav.filter((item) => !ADMIN_DESKTOP_PRIMARY_IDS.has(item.id)) : [];
  const overflowActive = desktopOverflowNav.some((item) => item.id === active);
  const desktopNavCount = desktopPrimaryNav.length + (desktopOverflowNav.length ? 1 : 0);
  const desktopActiveIndex = overflowActive
    ? desktopPrimaryNav.length
    : Math.max(0, desktopPrimaryNav.findIndex((item) => item.id === active));

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const context = gsap.context(() => {
      gsap.timeline({ defaults: { ease: 'power3.out' } })
        .fromTo(content, { autoAlpha: 0, y: 18, scale: .995 }, { autoAlpha: 1, y: 0, scale: 1, duration: .62, clearProps: 'transform,opacity,visibility' })
        .fromTo(content.querySelectorAll(':scope > .portal-heading, :scope > .cutaway-overview, :scope > .portal-panel, :scope > .recent-findings, :scope > .run-tape, .findings-ledger__heading, .reports-seal__heading, .targets-runway__heading, .signal-ports__heading, .settings-cabinet__heading'), { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: .56, stagger: .055 }, '-=.38')
        .fromTo(Array.from(content.querySelectorAll('.finding-detail, .data-row, .cutaway-ledger__row, .integration-card, .findings-ledger__record, .report-sheet, .report-inspector, .runway-target, .signal-port, .settings-cabinet__wall nav button, .settings-panel')).slice(0, 12), { autoAlpha: 0, y: 11 }, { autoAlpha: 1, y: 0, duration: .46, stagger: .045, clearProps: 'transform,opacity,visibility' }, '-=.34');
    }, content);
    return () => context.revert();
  }, [active]);

  useEffect(() => {
    const overlayOpen = menuOpen || adminMenuOpen || Boolean(popover);
    const popoverChanged = Boolean(popover) && overlayPopoverRef.current !== popover;
    const adminMenuChanged = adminMenuOpen && !overlayAdminMenuRef.current;
    if (overlayOpen && (!overlayWasOpenRef.current || popoverChanged || adminMenuChanged)) {
      if (!overlayWasOpenRef.current) {
        overlayReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : (menuTriggerRef.current || popoverTriggerRef.current);
        bodyOverflowRef.current = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
      }
      requestAnimationFrame(() => {
        if (menuOpen) sidebarCloseRef.current?.focus();
        else if (adminMenuOpen) adminMenuRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
        else popoverRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
      });
    }
    if (!overlayOpen && overlayWasOpenRef.current) {
      document.body.style.overflow = bodyOverflowRef.current || '';
      bodyOverflowRef.current = null;
      requestAnimationFrame(() => {
        if (overlayReturnRef.current?.isConnected) overlayReturnRef.current.focus();
        overlayReturnRef.current = null;
      });
    }
    overlayWasOpenRef.current = overlayOpen;
    overlayPopoverRef.current = popover;
    overlayAdminMenuRef.current = adminMenuOpen;
  }, [adminMenuOpen, menuOpen, popover]);

  useEffect(() => () => {
    if (bodyOverflowRef.current !== null) {
      document.body.style.overflow = bodyOverflowRef.current;
      bodyOverflowRef.current = null;
    }
  }, []);

  useEffect(() => {
    const revalidateVisibleSession = async () => {
      if (sessionRefreshInFlight.current || document.visibilityState === 'hidden') return;
      sessionRefreshInFlight.current = true;
      try {
        const session = await apiFetch<{ user?: { email?: string } }>('/api/auth/get-session');
        if (!session?.user) { navigate('/login', true); return; }
        if (admin) {
          try { await apiFetch('/api/v1/admin/me'); }
          catch { navigate('/app', true); }
          return;
        }
        if (identity?.email && session.user.email && identity.email.toLowerCase() !== session.user.email.toLowerCase()) {
          // Better Auth uses a shared same-origin cookie. A login in another tab
          // intentionally replaces that browser session, so reload this surface
          // before it can keep presenting the previous account's cached identity.
          window.location.reload();
        }
      } catch { navigate('/login', true); }
      finally { sessionRefreshInFlight.current = false; }
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') void revalidateVisibleSession(); };
    const onFocus = () => { void revalidateVisibleSession(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [admin, identity?.email]);

  useEffect(() => {
    if (!menuOpen && !adminMenuOpen && !popover) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (popover) setPopover(null);
        else if (adminMenuOpen) setAdminMenuOpen(false);
        else setMenuOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const container = menuOpen ? sidebarRef.current : adminMenuOpen ? adminMenuRef.current : popoverRef.current;
      if (!container) return;
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [adminMenuOpen, menuOpen, popover]);

  useEffect(() => {
    const compact = window.matchMedia('(max-width: 1080px)');
    const closeDesktopMenu = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setAdminMenuOpen(false);
    };
    closeDesktopMenu(compact);
    compact.addEventListener('change', closeDesktopMenu);
    return () => compact.removeEventListener('change', closeDesktopMenu);
  }, []);

  async function logout() {
    await apiFetch('/api/auth/sign-out', { method: 'POST' }).catch(() => null);
    navigate('/login', true);
  }
  const open = (next: typeof popover) => {
    popoverTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAdminMenuOpen(false);
    setPopover((current) => current === next ? null : next);
    if (next === 'notifications') setNotificationsSeen(true);
  };
  const go = (destination: string) => { switchPage(destination); setPopover(null); };
  const switchPage = (destination: string) => {
    setAdminMenuOpen(false);
    if (destination === active) { setMenuOpen(false); return; }
    // Navigation is state, not an animation completion side effect. A
    // background tab, a busy main thread or a suspended animation frame can
    // delay GSAP callbacks for seconds and leave the new nav item focused over
    // the previous page. Commit the route synchronously; the mounted surface
    // keeps its own bounded entrance motion.
    onNavigate(destination);
    setMenuOpen(false);
    window.scrollTo(0, 0);
  };

  return <div className={`portal-shell portal-shell--cutaway${admin ? ' portal-shell--admin' : ' portal-shell--workspace'}`}>
    <header className="portal-topbar">
      <BrandMark compact />
      <nav className={`portal-desktop-nav${active === 'status' ? ' has-utility-active' : ''}`} aria-label={admin ? 'Admin navigation' : 'Workspace navigation'} style={{ '--portal-index': desktopActiveIndex, '--portal-count': desktopNavCount } as CSSProperties}>
        <i className="portal-nav-blade" aria-hidden="true" />
        {desktopPrimaryNav.map((item) => {
          const Icon = item.icon;
          return <button key={item.id} aria-label={item.label} aria-current={active === item.id ? 'page' : undefined} className={active === item.id ? 'is-active' : ''} onClick={() => switchPage(item.id)}><Icon /><span>{item.label}</span></button>;
        })}
        {desktopOverflowNav.length > 0 && <div className="portal-admin-nav-more">
          <button type="button" aria-label="More admin sections" aria-haspopup="menu" aria-expanded={adminMenuOpen} aria-current={overflowActive ? 'page' : undefined} className={overflowActive ? 'is-active' : ''} onClick={() => { setPopover(null); setAdminMenuOpen((current) => !current); }}><span>More</span><ChevronDown /></button>
          {adminMenuOpen && <><button type="button" className="portal-popover-backdrop" onClick={() => setAdminMenuOpen(false)} aria-label="Close admin navigation menu" /><div ref={adminMenuRef} className="portal-admin-nav-more__menu" role="menu" aria-label="More admin sections">{desktopOverflowNav.map((item) => {
            const Icon = item.icon;
            return <button type="button" role="menuitem" key={item.id} className={active === item.id ? 'is-active' : ''} onClick={() => switchPage(item.id)}><Icon /><span>{item.label}</span></button>;
          })}</div></>}
        </div>}
      </nav>
      <div className="portal-topbar__actions">
        {!admin && <button aria-label="System Status" className={active === 'status' ? 'is-active' : ''} onClick={() => switchPage('status')}><Activity /></button>}
        <button aria-label="Notifications" className={!notificationsSeen && notifications.length ? 'has-badge' : ''} onClick={() => open('notifications')} aria-expanded={popover === 'notifications'}><Bell />{!notificationsSeen && notifications.length > 0 && <i>{Math.min(9, notifications.length)}</i>}</button>
        <button aria-label="Help" onClick={() => open('help')} aria-expanded={popover === 'help'}><HelpCircle /></button>
        <button className="portal-profile-trigger" onClick={() => open('profile')} aria-label="Open profile menu" aria-expanded={popover === 'profile'}><span className="portal-avatar">{initials}</span><ChevronDown /></button>
        <button ref={menuTriggerRef} className="portal-menu" onClick={() => setMenuOpen(true)} aria-label="Open navigation" aria-expanded={menuOpen} aria-controls="portal-mobile-navigation"><Menu /></button>
        {popover && <><button className="portal-popover-backdrop" onClick={() => setPopover(null)} aria-label="Close popover" /><div ref={popoverRef} className={`portal-popover portal-popover--${popover}`}>
          {popover === 'notifications' && <><header><b>Notifications</b><span>{notifications.length} recent</span><button className="portal-popover__close" onClick={() => setPopover(null)} aria-label="Close popover"><X /></button></header><div className="portal-popover__list">{notifications.length ? notifications.map((item) => <div key={item.id}><CheckCircle2 className={item.tone === 'warning' ? 'is-warning' : ''} /><span><b>{item.title}</b><small>{item.detail}</small></span></div>) : <p>No recent workspace events.</p>}</div></>}
          {popover === 'help' && <><header><b>Help center</b><span>Quick paths</span><button className="portal-popover__close" onClick={() => setPopover(null)} aria-label="Close popover"><X /></button></header><div className="portal-help-links"><button onClick={() => go('targets')}>Add a target<small>Public-link scans and optional DNS access</small></button><button onClick={() => go('reports')}>Reports and exports<small>PDF, JSON and Expert Review</small></button><button onClick={() => go('integrations')}>Connect tools<small>Source providers and webhooks</small></button></div></>}
          {popover === 'profile' && <><header><div className="portal-profile-summary"><span className="portal-avatar">{initials}</span><span><b>{identity?.name || 'Account'}</b><small>{identity?.email || identity?.role}</small></span></div><button className="portal-popover__close" onClick={() => setPopover(null)} aria-label="Close popover"><X /></button></header>{!admin && profileUsage && <section className="portal-profile-usage" aria-label="Remaining plan usage"><header><span>PLAN BALANCE</span><strong>{profileUsage.planName}</strong></header><div className="portal-profile-usage__primary"><article><span>Page credits</span><strong>{profileUsage.pageCredits.remaining}<small> / {profileUsage.pageCredits.limit}</small></strong><em>left this month</em></article><article><span>AI guidance</span><strong>{profileUsage.aiRemediations.remaining}<small> / {profileUsage.aiRemediations.limit}</small></strong><em>left this month</em></article></div><footer><span>Project slots <b>{profileUsage.projects.remaining} / {profileUsage.projects.limit}</b> left</span><span>Source audits <b>{profileUsage.sourceAudits.limit > 0 ? `${profileUsage.sourceAudits.remaining} / ${profileUsage.sourceAudits.limit} left` : 'Not included'}</b></span></footer></section>}<div className="portal-profile-menu"><button onClick={() => go('settings')}><Settings /> Account settings</button>{!admin && <><button onClick={() => go('status')}><Activity /> System status</button><button onClick={() => open('notifications')}><Bell /> Notifications</button><button onClick={() => open('help')}><HelpCircle /> Help center</button></>}<button onClick={() => void logout()}><LogOut /> Sign out</button></div></>}
        </div></>}
      </div>
    </header>

    <aside ref={sidebarRef} id="portal-mobile-navigation" className={`portal-sidebar${menuOpen ? ' is-open' : ''}`} role={menuOpen ? 'dialog' : undefined} aria-label={admin ? 'Admin navigation' : 'Workspace navigation'} aria-hidden={!menuOpen} aria-modal={menuOpen ? 'true' : undefined}>
      <div className="portal-sidebar__head"><BrandMark compact /><button ref={sidebarCloseRef} onClick={() => setMenuOpen(false)} aria-label="Close navigation"><X /></button></div>
      <div className="portal-sidebar__context"><span>{admin ? 'CONTROL PLANE' : 'VERIFIED WORKSPACE'}</span><b>{String(activeIndex + 1).padStart(2, '0')} / {nav.find((item) => item.id === active)?.label}</b></div>
      <nav aria-label={admin ? 'Admin navigation' : 'Workspace navigation'}>{primaryNav.map((item, index) => {
        const Icon = item.icon;
        return <button key={item.id} aria-label={item.label} aria-current={active === item.id ? 'page' : undefined} className={active === item.id ? 'is-active' : ''} onClick={() => switchPage(item.id)}><small>{String(index + 1).padStart(2, '0')}</small><Icon /><span>{item.label}</span></button>;
      })}</nav>
      <div className="portal-sidebar__bottom">{footerCard}<button className="portal-identity" onClick={() => { setMenuOpen(false); open('profile'); }}><span>{initials}</span><span><b>{identity?.name || (admin ? 'Admin' : 'Account')}</b><small>{identity?.role || identity?.email || 'Account menu'}</small></span><ChevronDown /></button></div>
    </aside>
    {menuOpen && <button className="portal-backdrop" onClick={() => setMenuOpen(false)} aria-label="Close navigation" />}

    <main className="portal-main">
      <div className="portal-content" data-portal-view={active} ref={contentRef}>{children}</div>
    </main>
  </div>;
}
