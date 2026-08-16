import { useEffect, useState } from 'react';

export function navigate(path: string, replace = false) {
  // Route state is an application invariant, not a visual-transition callback.
  // Chrome may defer or skip a View Transition update while another animation,
  // dialog or tab lifecycle change is in flight. Updating history synchronously
  // keeps the URL, active navigation item and mounted surface atomic.
  if (replace) window.history.replaceState({}, '', path);
  else window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

export function useRoutePath() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return path;
}
