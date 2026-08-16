export type AdminView =
  | 'dashboard'
  | 'users'
  | 'workspaces'
  | 'scans'
  | 'entitlements'
  | 'redeem'
  | 'audit'
  | 'findings'
  | 'reports'
  | 'support'
  | 'expert_reviews'
  | 'engine_lab'
  | 'lab_results'
  | 'integrations'
  | 'security'
  | 'settings';

const canonicalPaths: Record<AdminView, string> = {
  dashboard: '/admin',
  users: '/admin/users',
  workspaces: '/admin/workspaces',
  scans: '/admin/scans',
  entitlements: '/admin/entitlements',
  redeem: '/admin/redeem',
  audit: '/admin/audit',
  findings: '/admin/findings',
  reports: '/admin/reports',
  support: '/admin/support',
  expert_reviews: '/admin/expert-reviews',
  engine_lab: '/admin/engine-lab',
  lab_results: '/admin/lab-results',
  integrations: '/admin/integrations',
  security: '/admin/security',
  settings: '/admin/settings',
};

const aliases: Record<string, AdminView> = {
  '/admin': 'dashboard',
  '/admin/': 'dashboard',
  '/admin/overview': 'dashboard',
  '/admin/dashboard': 'dashboard',
  '/admin/users': 'users',
  '/admin/workspaces': 'workspaces',
  '/admin/scans': 'scans',
  '/admin/entitlements': 'entitlements',
  '/admin/redeem': 'redeem',
  '/admin/audit': 'audit',
  '/admin/findings': 'findings',
  '/admin/reports': 'reports',
  '/admin/support': 'support',
  '/admin/expert-reviews': 'expert_reviews',
  '/admin/expert_reviews': 'expert_reviews',
  '/admin/engine-lab': 'engine_lab',
  '/admin/engine_lab': 'engine_lab',
  '/admin/lab-results': 'lab_results',
  '/admin/lab_results': 'lab_results',
  '/admin/integrations': 'integrations',
  '/admin/security': 'security',
  '/admin/settings': 'settings',
};

export function adminViewFromPath(path: string): AdminView | null {
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return aliases[normalized] || null;
}

export function adminPathForView(view: AdminView): string {
  return canonicalPaths[view];
}

export function adminCanonicalPath(path: string): string | null {
  const view = adminViewFromPath(path);
  return view ? adminPathForView(view) : null;
}

export const adminViewLabels: Record<AdminView, string> = {
  dashboard: 'Dashboard',
  users: 'Users',
  workspaces: 'Workspaces',
  scans: 'Scans',
  entitlements: 'Entitlements',
  redeem: 'Redeem Codes',
  audit: 'Audit Log',
  findings: 'Findings',
  reports: 'Reports',
  support: 'Support Inbox',
  expert_reviews: 'Expert Reviews',
  engine_lab: 'Engine Test Lab',
  lab_results: 'Lab Results',
  integrations: 'Integrations',
  security: 'Security',
  settings: 'Settings',
};
