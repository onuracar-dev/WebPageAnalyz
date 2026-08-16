import type { Page, Route } from '@playwright/test';
import { PUBLIC_PLANS } from '../src/planCatalog';

const now = '2026-08-12T10:00:00.000Z';

export const ADMIN_FIXTURE_PERMISSIONS = [
  'admin.session.read', 'system.read', 'users.read', 'users.ban', 'users.unban',
  'workspaces.read', 'workspaces.suspend', 'workspaces.unsuspend',
  'credits.read', 'credits.manage', 'entitlements.read', 'entitlements.manage',
  'scans.read', 'scans.retry', 'scans.cancel', 'support.read', 'support.reply',
  'support.internal_note', 'support.manage', 'redeem.read', 'redeem.manage',
  'billing.read', 'billing.reconcile', 'audit.read', 'webhooks.read',
  'webhooks.replay', 'engine_lab.read', 'engine_lab.execute', 'engine_lab.cancel',
  'expert_reviews.read', 'expert_reviews.manage', 'expert_reviews.finalize',
  'reports.read', 'security.self.read', 'security.self.manage',
  'security.self.recovery', 'security.activity.read',
] as const;

export const legalConfig = {
  ready: true,
  operator: {
    name: 'Northstar Test Yazilim Ltd. Sti.', type: 'limited_company', businessAddress: 'Test Mahallesi 1, Istanbul', country: 'Türkiye',
    supportEmail: 'support@example.test', supportPhone: '+90 212 000 0000', effectiveDate: '2026-08-15T00:00:00.000Z',
  },
  documents: Object.fromEntries([
    ['terms', 'terms'], ['privacy', 'privacy'], ['kvkk', 'kvkk'], ['acceptableUse', 'acceptable_use'], ['refund', 'refund'], ['subprocessors', 'subprocessors'], ['targetAuthorization', 'target_authorization'],
  ].map(([key, id]) => [key, { id, version: '1.0', path: `/${key === 'acceptableUse' ? 'acceptable-use' : key}` }])),
  billing: { paymentsEnabled: false, mode: 'redeem_only', provider: 'paddle', merchantOfRecord: null, enterpriseSalesMode: 'contact', recurring: false, termsPath: '/terms', refundPath: '/refund', cancellationPath: '/app/settings/billing' },
  subprocessors: [{ provider: 'Resend', purpose: 'Transactional email delivery', dataCategories: ['recipient email', 'delivery state'] }],
};

export const labRun = {
  id: 'lab-run-001', targetUrl: 'https://northstar.example/', targetOrigin: 'https://northstar.example', status: 'completed', createdAt: now, completedAt: now,
  summary: { completed: 2, failed: 0, unavailable: 0 },
  engines: [
    { engineId: 'wpaPage', label: 'WPA Page', version: '1.0.0', status: 'completed', progress: 100, progressMode: 'stage_estimate', phase: 'evidence sealed', findingsCount: 1, evidence: [{ kind: 'finding_samples', label: 'Normalized evidence', samples: [{ ruleId: 'runtime.console-errors.desktop', title: 'Browser console errors occurred', severity: 'high', description: 'A script threw while initializing checkout.', pageUrl: 'https://northstar.example/checkout', device: 'desktop', confidence: 1, fingerprint: '707ba7daf874', remediation: 'Guard the checkout session before dereferencing it.', source: { name: 'WPA Page', version: '1.0.0' }, evidence: [{ type: 'console', value: 'TypeError: checkout session is undefined' }] }] }] },
    { engineId: 'performancePlus', label: 'Performance Plus', version: '1.0.0', status: 'completed', progress: 100, progressMode: 'stage_estimate', phase: 'evidence sealed', findingsCount: 1, evidence: [{ kind: 'finding_samples', label: 'Measured budgets', samples: [{ ruleId: 'performance.long-task.desktop', title: 'Long main-thread task', severity: 'medium', pageUrl: 'https://northstar.example/', fingerprint: 'long-task-001', remediation: 'Split the blocking initialization work.', evidence: [{ type: 'metric', value: { durationMs: 420 } }] }] }] },
  ],
};

export const runningLabRun = {
  ...labRun,
  id: 'lab-run-running',
  targetUrl: 'https://inflight.example/',
  targetOrigin: 'https://inflight.example',
  status: 'running',
  completedAt: undefined,
  summary: { completed: 0, failed: 0, unavailable: 0 },
  engines: labRun.engines.map((engine, index) => ({
    ...engine,
    status: 'running',
    progress: index === 0 ? 64 : 38,
    phase: 'bounded browser execution',
    findingsCount: 0,
    evidence: [],
  })),
};

export const workspaceDashboard = {
  workspace: { id: 'ws-001', name: 'Northstar Studio' },
  plan: {
    id: 'studio', name: 'Studio', limits: { pageCredits: 150, projects: 15, aiRemediations: 1000, sourceAudits: 1 },
    entitlements: {
      core_audit: { executionMode: 'automated' }, runtime: { executionMode: 'automated' }, seo: { executionMode: 'automated' },
      geo: { executionMode: 'automated', limit: 'advanced' }, design: { executionMode: 'automated', limit: 'advanced' }, backend_surface: { executionMode: 'automated' },
      full_site_crawl: { executionMode: 'automated' }, performance_plus: { executionMode: 'automated' }, passive_security: { executionMode: 'automated' },
      source_audit: { executionMode: 'automated', limit: 1 }, ai_remediation: { executionMode: 'automated', limit: 1000 },
    },
  },
  usage: { consumed: 38, reserved: 2 },
  allowances: {
    periodStart: '2026-08-01',
    pageCredits: { limit: 150, used: 40, remaining: 110, consumed: 38, reserved: 2 },
    aiRemediations: { limit: 1000, used: 12, remaining: 988 },
    projects: { limit: 15, used: 3, remaining: 12 },
    sourceAudits: { limit: 1, used: 0, remaining: 1 },
  },
  projects: [
    { id: 'project-001', name: 'Northstar', origin: 'https://northstar.example', verifiedAt: now },
    { id: 'project-002', name: 'Northstar Docs', origin: 'https://docs.northstar.example', verifiedAt: null, verificationToken: 'fixture-proof-token' },
    { id: 'project-003', name: 'Northstar Status', origin: 'https://status.northstar.example', verifiedAt: now },
  ],
  scans: [{ id: 'scan-001', status: 'completed', createdAt: now, completedAt: now }],
  metrics: { activeFindings: 6, critical: 1, highPriority: 3, resolved: 4, totalPages: 28 },
  recentFindings: [{ title: 'Browser console errors occurred', severity: 'high', pageUrl: 'https://northstar.example/checkout', createdAt: now }],
  trend: Array.from({ length: 6 }, (_, index) => ({ at: `2026-07-${String(7 + index * 7).padStart(2, '0')}T00:00:00.000Z`, count: index + 2 })),
};

const findings = [{
  fingerprint: '707ba7daf874', title: 'Browser console errors occurred', description: 'A script threw while initializing checkout.', severity: 'high', category: 'runtime', pageUrl: 'https://northstar.example/checkout', createdAt: now,
  ruleId: 'runtime.console-errors.desktop', moduleId: 'runtime', engineId: 'wpaPage', device: 'desktop', kind: 'measured', confidence: 1, coverage: { devices: ['desktop', 'mobile'], truncated: false }, remediation: 'Guard the checkout session before dereferencing it.', state: 'active', evidence: [{ type: 'console', value: 'TypeError: checkout session is undefined' }], source: { name: 'WPA Page', version: '1.0.0' },
}];

const reportDetails = [
  { id: 'report-001', scanId: 'scan-001', status: 'automated_incomplete', createdAt: now, version: 3, payload: { summary: { terminalState: 'partial', requestedPages: 2, completedPages: 1, incompletePages: 1, failedPages: 0, unavailablePages: 0 }, modules: { core_audit: { status: 'unavailable', engines: ['lighthouse', 'axe', 'yellowLab'], errorCode: 'ANALYZER_UNAVAILABLE' }, runtime: { status: 'completed', engines: ['wpaPage'] }, full_site_crawl: { status: 'completed', engines: ['crawler'], coverage: { crawler: { sources: { root: { references: 1, uniqueUrls: 1 }, sitemap: { references: 3, uniqueUrls: 2 }, manual: { references: 1, uniqueUrls: 1 } }, truncated: false } } } }, pages: [{ url: 'https://northstar.example/' }] } },
  { id: 'report-002', scanId: 'scan-002', status: 'published', createdAt: '2026-08-05T10:00:00.000Z', version: 2, payload: { summary: { terminalState: 'complete', requestedPages: 12, completedPages: 12 }, modules: { core_audit: { status: 'completed', engines: ['lighthouse', 'axe'] }, runtime: { status: 'completed', engines: ['wpaPage'] } }, pages: [{ url: 'https://northstar.example/' }] } },
  { id: 'report-003', scanId: 'scan-003', status: 'automated_draft', createdAt: '2026-07-28T10:00:00.000Z', version: 1, payload: { summary: { terminalState: 'complete', requestedPages: 8, completedPages: 8 }, modules: { core_audit: { status: 'completed', engines: ['lighthouse', 'axe'] } }, pages: [{ url: 'https://northstar.example/' }] } },
];

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** Install deterministic data for dashboard, admin and Engine Lab route tests. */
export async function installApiFixtures(page: Page, mode: 'workspace' | 'signal' | 'running' | 'admin' | 'admin-denied' | 'admin-reauth' = 'workspace', failurePath?: string) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (failurePath && path === failurePath) return json(route, { error: `Fixture outage for ${failurePath}` }, 503);
    if (path === '/api/v1/plans') return json(route, { plans: PUBLIC_PLANS.filter((plan) => ['signal', 'studio', 'enterprise'].includes(plan.id)) });
    if (path === '/api/v1/legal/config') return json(route, legalConfig);
    if (path === '/api/v1/legal/acceptances') return json(route, { acceptance: { id: 'acceptance-001', acceptedAt: now } }, 201);
    if (path === '/api/auth/get-session') return json(route, { user: { name: ['workspace', 'signal', 'running'].includes(mode) ? 'Avery Example' : 'Admin Example', email: 'avery@example.test', twoFactorEnabled: true } });
    if (path === '/api/v1/dashboard') return json(route, mode === 'signal' ? {
      ...workspaceDashboard,
      plan: {
        id: 'signal', name: 'Signal', limits: { pageCredits: 25, projects: 3, aiRemediations: 100, sourceAudits: 0 },
        entitlements: {
          core_audit: { executionMode: 'automated' }, runtime: { executionMode: 'automated' }, seo: { executionMode: 'automated' },
          geo: { executionMode: 'automated', limit: 'basic' }, design: { executionMode: 'automated', limit: 'basic' }, backend_surface: { executionMode: 'automated' },
        },
      },
    } : mode === 'running' ? { ...workspaceDashboard, scans: [{ id: 'scan-live', projectId: 'project-001', status: 'running', createdAt: now, manifest: { urls: ['https://northstar.example/'] } }] } : workspaceDashboard);
    if (path === '/api/v1/reports') return json(route, { reports: reportDetails.map(({ payload, ...summary }) => ({ ...summary, summary: payload.summary })) });
    const reportDetail = path.match(/^\/api\/v1\/reports\/([^/]+)$/);
    if (reportDetail) {
      const report = reportDetails.find((entry) => entry.id === decodeURIComponent(reportDetail[1]));
      return report ? json(route, { report }) : json(route, { error: 'Report not found.' }, 404);
    }
    if (path.startsWith('/api/v1/reports/compare/')) return json(route, { left: 'report-002', right: 'report-001', newFindings: ['fixture-new-fingerprint'], fixedFindings: ['fixture-fixed-fingerprint'], unchangedFindings: ['fixture-unchanged-fingerprint'] });
    if (/^\/api\/v1\/reports\/[^/]+\/share$/.test(path)) {
      if (route.request().method() === 'DELETE') return json(route, { reportId: path.split('/')[4], status: 'revoked', revokedAt: now });
      return json(route, { reportId: path.split('/')[4], token: 'fixture-share-token-1234567890', pagePath: '/shared-reports/fixture-share-token-1234567890', status: 'active', expiresInDays: 7, expiresAt: '2026-08-19T10:00:00.000Z' }, 201);
    }
    if (path === '/api/v1/findings') return json(route, { findings, total: 1, activeTotal: 1, resolvedTotal: 0 });
    if (path === '/api/v1/findings/707ba7daf874/remediation' && route.request().method() === 'POST') return json(route, {
      remediation: {
        schemaVersion: 'wpa.ai.remediation.v1',
        summary: 'Guard checkout initialization before reading the session.',
        likelyCause: 'The checkout session is read before asynchronous initialization completes.',
        steps: ['Check that the session exists before dereferencing it.', 'Re-run the measured browser scan after the smallest safe change.'],
        codeExample: 'if (!checkoutSession) return;',
        caveats: ['Verify the suggestion against the actual application state and a new measurement.'],
        confidence: 'medium',
      },
      cached: false,
      semantics: 'ai_generated_suggestion',
      quota: { limit: 1000, used: 1, remaining: 999 },
      generatedAt: now,
    }, 201);
    if (path === '/api/v1/projects' && route.request().method() === 'POST') return json(route, { project: { id: 'project-created', name: 'Created target', origin: 'https://created.example', verifiedAt: null, verificationToken: 'created-proof-token' } }, 201);
    if (path === '/api/v1/scans' && route.request().method() === 'POST') return json(route, { scan: { id: 'scan-created', status: 'queued', createdAt: now } }, 202);
    if (path === '/api/v1/billing/checkout' && route.request().method() === 'POST') return json(route, { url: 'https://checkout.paddle.test/transaction-001' }, 201);
    if (path === '/api/v1/redeem' && route.request().method() === 'POST') return json(route, {
      effective: { id: 'studio', name: 'Studio', effectivePlanId: 'studio', limits: { pageCredits: 200, aiRemediations: 1500 } },
      redemption: { id: 'redemption-001', redeemedAt: now },
    }, 201);
    if (path === '/api/v1/scans/scan-live/progress') return json(route, {
      scan: { id: 'scan-live', projectId: 'project-001', status: 'running', createdAt: now, manifest: { urls: ['https://northstar.example/'] } },
      counts: { queued: 0, running: 1, completed: 0 },
      pages: [{ pageKey: 'page-live', pageIndex: 0, url: 'https://northstar.example/', status: 'running', modules: {} }],
      events: [
        { id: 10, type: 'analysis.plan', createdAt: now, payload: { pageKey: 'page-live', pageIndex: 0, engines: [
          { executionId: 'lighthouse', engineIds: ['lighthouse'], resourceClass: 'browser', timeoutBudgetMs: 180000 },
          { executionId: 'yellowLab', engineIds: ['yellowLab'], resourceClass: 'external', timeoutBudgetMs: 150000 },
          { executionId: 'axe', engineIds: ['axe'], resourceClass: 'browser', timeoutBudgetMs: 90000 },
          { executionId: 'wpaPage', engineIds: ['wpaPage'], resourceClass: 'browser', timeoutBudgetMs: 120000 },
          { executionId: 'advancedBrowser', engineIds: ['performancePlus', 'advancedGeo', 'visualUx'], resourceClass: 'browser', timeoutBudgetMs: 150000 },
        ] } },
        { id: 11, type: 'engine.completed', createdAt: now, payload: { pageKey: 'page-live', pageIndex: 0, executionId: 'lighthouse', engineIds: ['lighthouse'], resourceClass: 'browser', status: 'completed', executionMs: 24220 } },
        { id: 12, type: 'engine.completed', createdAt: now, payload: { pageKey: 'page-live', pageIndex: 0, executionId: 'yellowLab', engineIds: ['yellowLab'], resourceClass: 'external', status: 'completed', executionMs: 16653 } },
        { id: 13, type: 'engine.running', createdAt: now, payload: { pageKey: 'page-live', pageIndex: 0, executionId: 'axe', engineIds: ['axe'], resourceClass: 'browser', status: 'running' } },
      ],
      lastEventId: 13,
      historyLimit: 200,
    });
    if (path === '/api/v1/status') return json(route, { checkedAt: now, overall: 'operational', components: [{ id: 'database', label: 'Database', status: 'operational', detail: 'Public readiness is available.' }] });
    if (path === '/api/v1/status/details') return json(route, { checkedAt: now, overall: 'operational', components: [{ id: 'database', label: 'Database', status: 'operational', detail: 'Read/write checks pass.' }, { id: 'workers', label: 'Workers', status: 'operational', detail: 'Jobs are available.' }] });
    if (path === '/api/v1/integrations') return json(route, { integrations: [
      { provider: 'github', label: 'GitHub', available: true, serverConfigured: true, status: 'connected', displayName: 'northstar-studio', connectedAt: now, lastVerifiedAt: now },
      { provider: 'gitlab', label: 'GitLab', available: true, serverConfigured: true, status: 'not_connected' },
      { provider: 'bitbucket', label: 'Bitbucket', available: true, serverConfigured: false, status: 'not_connected' },
      { provider: 'webhook', label: 'Webhook', available: false, serverConfigured: true, status: 'not_configured' },
    ] });
    if (path === '/api/v1/source-inputs') return json(route, { sourceInputs: [{ id: 'source-001', projectId: 'project-001', status: 'unavailable', failureCode: 'OSV_UNAVAILABLE', createdAt: now, result: { schemaVersion: 'wpa.source-audit.v1', module: { findingCount: 0, remediation: 'Install the OSV-Scanner executable, then rerun the audit.' }, findings: [], coverage: { manifests: 0, extractedFiles: 14, truncated: false } } }] });
    if (path === '/api/v1/settings') return json(route, { workspace: { name: 'Northstar Studio' }, settings: { defaultLocale: 'en', notifyScanComplete: true, notifyHighPriority: true, weeklyDigest: false }, subscription: null });
    if (path === '/api/v1/analysis-capabilities') return json(route, { version: 'wpa.analysis-capabilities.v1', findingSchema: 'wpa.finding.v1', reportSchema: 'wpa.report.v2', engines: { lighthouse: {}, axe: {}, yellowLab: {}, wpaPage: {}, crawler: {}, performancePlus: {}, advancedGeo: {}, visualUx: {}, journey: {}, zapBaseline: {}, osvScanner: {} } });
    if (path === '/api/v1/admin/me') {
      if (mode === 'admin-denied') return json(route, { error: 'Administrator role required.', code: 'ADMIN_ROLE_REQUIRED' }, 403);
      return json(route, { admin: { actorId: 'admin-001', email: 'admin@example.test', role: 'admin', permissions: ADMIN_FIXTURE_PERMISSIONS, via: 'session' } });
    }
    if (path === '/api/v1/admin/overview') return json(route, { totals: { users: 12, scans: 34, reports: 28, findings: 64, critical: 2 }, activity: [{ id: 'activity-001', action: 'scan.queued', entityType: 'scan', entityId: 'scan-001', createdAt: now }], health: [{ id: 'database', label: 'Database', status: 'operational', value: 'ready' }, { id: 'workers', label: 'Workers', status: 'operational', value: '3 online' }] });
    if (path === '/api/v1/admin/operator-tasks') return json(route, { tasks: [] });
    if (path === '/api/v1/admin/engine-lab/catalog') return json(route, { engines: [
      { id: 'wpaPage', label: 'WPA Page', version: '1.0.0', owner: 'internal', input: 'url', expectedSeconds: 12, configured: true, progressMode: 'stage_estimate' },
      { id: 'performancePlus', label: 'Performance Plus', version: '1.0.0', owner: 'internal', input: 'url', expectedSeconds: 18, configured: true, progressMode: 'stage_estimate' },
    ] });
    if (path === '/api/v1/admin/expert-reviews') return json(route, { reviews: [] });
    if (path === '/api/v1/admin/engine-lab/runs') return json(route, { runs: [runningLabRun, labRun] });
    if (path === `/api/v1/admin/engine-lab/runs/${runningLabRun.id}`) return json(route, { run: runningLabRun });
    if (path === `/api/v1/admin/engine-lab/runs/${labRun.id}`) return json(route, { run: labRun });
    if (path.startsWith('/api/v1/admin/resources/')) return json(route, { resources: [] });
    return json(route, { error: `Unexpected test fixture request: ${path}` }, 404);
  });
}
