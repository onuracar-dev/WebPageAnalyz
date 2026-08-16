/**
 * Static marketing contract. Keep this checked against backend/domain/plans.js
 * when plan copy or entitlements change; the public landing page must not call
 * the workspace API or infer live billing state.
 */
export const PUBLIC_PLANS = [
  {
    id: 'free',
    name: 'Free',
    priceUsd: 0,
    description: 'A bounded workspace for evaluating the core audit and remediation workflow.',
    limits: { pageCredits: 5, projects: 1, seats: 1, retentionDays: 7, sourceAudits: 0, aiRemediations: 5 },
    entitlements: {
      core_audit: { executionMode: 'automated', limit: null }, runtime: { executionMode: 'automated', limit: 'basic' }, seo: { executionMode: 'automated', limit: 'basic' },
      geo: { executionMode: 'automated', limit: 'basic' }, design: { executionMode: 'automated', limit: 'basic' }, backend_surface: { executionMode: 'automated', limit: 'basic' },
      ai_remediation: { executionMode: 'automated', limit: 5 },
    },
    features: [
      '5 page credits / month',
      '1 project',
      'Core browser, SEO/GEO, design and backend-surface evidence',
      '5 AI remediation generations / month',
      '7-day report history',
    ],
  },
  {
    id: 'signal',
    name: 'Signal',
    priceUsd: 29,
    description: 'Automated desktop and mobile evidence for a small website or product portfolio.',
    limits: { pageCredits: 25, projects: 3, seats: 1, retentionDays: 30, sourceAudits: 0, aiRemediations: 100 },
    entitlements: {
      core_audit: { executionMode: 'automated', limit: null }, runtime: { executionMode: 'automated', limit: null }, seo: { executionMode: 'automated', limit: null },
      geo: { executionMode: 'automated', limit: 'basic' }, design: { executionMode: 'automated', limit: 'basic' }, backend_surface: { executionMode: 'automated', limit: 'basic' },
      ai_remediation: { executionMode: 'automated', limit: 100 },
    },
    features: [
      '25 page credits / month',
      '3 projects',
      'Lighthouse, Axe, YellowLab + WPA core inspection',
      'Runtime, SEO/GEO, responsive UX and backend-surface checks',
      'TR/EN JSON + PDF/print reports',
      '30-day report history',
    ],
  },
  {
    id: 'studio',
    name: 'Studio',
    priceUsd: 99,
    description: 'Automated whole-site quality, advanced browser evidence and passive security for teams.',
    limits: { pageCredits: 150, projects: 15, seats: 5, retentionDays: 90, sourceAudits: 1, aiRemediations: 1000 },
    entitlements: {
      core_audit: { executionMode: 'automated', limit: null }, runtime: { executionMode: 'automated', limit: null }, seo: { executionMode: 'automated', limit: null },
      geo: { executionMode: 'automated', limit: 'advanced' }, design: { executionMode: 'automated', limit: 'advanced' }, backend_surface: { executionMode: 'automated', limit: 'advanced' },
      full_site_crawl: { executionMode: 'automated', limit: null }, performance_plus: { executionMode: 'automated', limit: null }, passive_security: { executionMode: 'automated', limit: null },
      source_audit: { executionMode: 'automated', limit: 1 },
      ai_remediation: { executionMode: 'automated', limit: 1000 },
    },
    features: [
      '150 page credits / month',
      '15 projects',
      'Everything in Signal + full-site crawl',
      'Advanced SEO/GEO, Visual UX and Performance Plus review',
      'Passive security + 1 source audit / month',
      'Report comparisons + shareable read-only reports',
      '90-day report history',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    priceUsd: 349,
    description: 'Highest-volume coverage with source, journey and signed report-webhook delivery.',
    limits: { pageCredits: 500, projects: 50, seats: 15, retentionDays: 365, sourceAudits: 4, aiRemediations: 5000 },
    entitlements: {
      core_audit: { executionMode: 'automated', limit: null }, runtime: { executionMode: 'automated', limit: null }, seo: { executionMode: 'automated', limit: null },
      geo: { executionMode: 'automated', limit: 'advanced' }, design: { executionMode: 'automated', limit: 'advanced' }, backend_surface: { executionMode: 'automated', limit: 'advanced' },
      full_site_crawl: { executionMode: 'automated', limit: null }, performance_plus: { executionMode: 'automated', limit: null }, passive_security: { executionMode: 'automated', limit: null },
      source_audit: { executionMode: 'automated', limit: 4 }, journey_test: { executionMode: 'automated', limit: null }, api_webhooks: { executionMode: 'automated', limit: null },
      ai_remediation: { executionMode: 'automated', limit: 5000 },
    },
    features: [
      '500 page credits / month',
      '50 projects',
      'Everything in Studio + 4 source audits / month',
      'Read-only journey tests + signed report webhooks',
      '365-day report history + workspace support tickets',
    ],
  },
] as const;

export type PublicPlan = (typeof PUBLIC_PLANS)[number];
