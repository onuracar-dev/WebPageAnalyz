import { lazy, Suspense, type ReactNode } from 'react';
import ProductSite from './ProductSite';
import { useRoutePath } from './portal/router';
import AuxiliaryPage from './AuxiliaryPages';

const AdminDashboard = lazy(() => import('./portal/AdminDashboard'));
const AuthPage = lazy(() => import('./portal/AuthPage'));
const UserDashboard = lazy(() => import('./portal/UserDashboard'));
const SupportCenter = lazy(() => import('./portal/SupportCenter'));

function RouteLoader({ children }: { children: ReactNode }) {
  return <Suspense fallback={<main className="route-loader"><i /><span>Loading WPA...</span></main>}>{children}</Suspense>;
}

function sharedTokenFromPath(path: string) {
  const prefix = path.startsWith('/shared-reports/') ? '/shared-reports/' : path.startsWith('/share/') ? '/share/' : '';
  if (!prefix) return null;
  const raw = path.slice(prefix.length);
  if (raw.includes('/')) return '';
  try { return decodeURIComponent(raw); } catch { return ''; }
}

function App() {
  const path = useRoutePath();

  if (path === '/login') return <RouteLoader><AuthPage mode="login" /></RouteLoader>;
  if (path === '/register') return <RouteLoader><AuthPage mode="register" /></RouteLoader>;
  if (path === '/admin' || path.startsWith('/admin/')) return <RouteLoader><AdminDashboard /></RouteLoader>;
  if (path === '/app/support') return <RouteLoader><SupportCenter /></RouteLoader>;
  if (path === '/app' || path.startsWith('/app/')) return <RouteLoader><UserDashboard /></RouteLoader>;
  if (path === '/faq') return <AuxiliaryPage kind="faq" />;
  if (path === '/status') return <AuxiliaryPage kind="status" />;
  if (path === '/contact') return <AuxiliaryPage kind="contact" />;
  if (path === '/forgot-password') return <AuxiliaryPage kind="forgot-password" />;
  if (path === '/verify-email') return <AuxiliaryPage kind="verify-email" />;
  if (path === '/privacy') return <AuxiliaryPage kind="privacy" />;
  if (path === '/terms') return <AuxiliaryPage kind="terms" />;
  if (path === '/kvkk') return <AuxiliaryPage kind="kvkk" />;
  if (path === '/acceptable-use') return <AuxiliaryPage kind="acceptable-use" />;
  if (path === '/refund') return <AuxiliaryPage kind="refund" />;
  if (path === '/subprocessors') return <AuxiliaryPage kind="subprocessors" />;
  if (path.startsWith('/shared-reports/') || path.startsWith('/share/')) return <AuxiliaryPage kind="shared-report" token={sharedTokenFromPath(path) || ''} />;
  if (path === '/404') return <AuxiliaryPage kind="404" path={path} />;
  if (path === '/') return <ProductSite />;
  return <AuxiliaryPage kind="404" path={path} />;
}

export default App;
