import { useEffect, useState } from 'react';

export type Route =
  | { name: 'jobs' }
  | { name: 'job'; id: string }
  | { name: 'fill'; id: string }
  | { name: 'templates' };

export function parse(path: string): Route {
  const p = path.replace(/\/+$/, '') || '/';
  const f = p.match(/^\/j\/([^/]+)\/fill$/);
  if (f) return { name: 'fill', id: f[1] };
  const m = p.match(/^\/j\/([^/]+)$/);
  if (m) return { name: 'job', id: m[1] };
  if (p === '/templates') return { name: 'templates' };
  return { name: 'jobs' };
}

export const paths = {
  jobs: () => '/',
  job: (id: string) => `/j/${id}`,
  fill: (id: string) => `/j/${id}/fill`,
  templates: () => '/templates',
};

const listeners = new Set<() => void>();
export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  listeners.forEach((l) => l());
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(location.pathname));
  useEffect(() => {
    const on = () => setRoute(parse(location.pathname));
    listeners.add(on);
    window.addEventListener('popstate', on);
    return () => {
      listeners.delete(on);
      window.removeEventListener('popstate', on);
    };
  }, []);
  return route;
}
