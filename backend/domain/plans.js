const MODULES = Object.freeze({
    CORE_AUDIT: 'core_audit',
    RUNTIME: 'runtime',
    SEO: 'seo',
    GEO: 'geo',
    DESIGN: 'design',
    BACKEND_SURFACE: 'backend_surface',
    FULL_SITE_CRAWL: 'full_site_crawl',
    PERFORMANCE_PLUS: 'performance_plus',
    PASSIVE_SECURITY: 'passive_security',
    SOURCE_AUDIT: 'source_audit',
    MONITORING: 'monitoring',
    WHITE_LABEL: 'white_label',
    JOURNEY_TEST: 'journey_test',
    EXPERT_REVIEW: 'expert_review',
    API_WEBHOOKS: 'api_webhooks',
    AI_REMEDIATION: 'ai_remediation'
});

const mode = (executionMode, limit = null) => Object.freeze({ executionMode, limit });

// Free is a real entitlement state, but it is deliberately not part of the
// three public paid packages exported as PLANS. This keeps the established
// pricing contract stable while making unpaid/default access explicit.
const FREE_PLAN = Object.freeze({
    id: 'free',
    name: 'Free',
    priceUsd: 0,
    description: 'A bounded workspace for evaluating the core audit and remediation workflow.',
    limits: Object.freeze({ pageCredits: 5, projects: 1, seats: 1, retentionDays: 7, sourceAudits: 0, aiRemediations: 5 }),
    entitlements: Object.freeze({
        [MODULES.CORE_AUDIT]: mode('automated'),
        [MODULES.RUNTIME]: mode('automated', 'basic'),
        [MODULES.SEO]: mode('automated', 'basic'),
        [MODULES.GEO]: mode('automated', 'basic'),
        [MODULES.DESIGN]: mode('automated', 'basic'),
        [MODULES.BACKEND_SURFACE]: mode('automated', 'basic'),
        [MODULES.AI_REMEDIATION]: mode('automated', 5)
    }),
    features: Object.freeze([
        '5 page credits / month',
            '1 project',
        'Core browser, SEO/GEO, design and backend-surface evidence',
        '5 AI remediation generations / month',
        '7-day report history'
    ])
});

const PLANS = Object.freeze([
    Object.freeze({
        id: 'signal',
        name: 'Signal',
        priceUsd: 29,
        description: 'Automated desktop and mobile evidence for a small website or product portfolio.',
        limits: Object.freeze({ pageCredits: 25, projects: 3, seats: 1, retentionDays: 30, sourceAudits: 0, aiRemediations: 100 }),
        entitlements: Object.freeze({
            [MODULES.CORE_AUDIT]: mode('automated'),
            [MODULES.RUNTIME]: mode('automated'),
            [MODULES.SEO]: mode('automated'),
            [MODULES.GEO]: mode('automated', 'basic'),
            [MODULES.DESIGN]: mode('automated', 'basic'),
            [MODULES.BACKEND_SURFACE]: mode('automated', 'basic'),
            [MODULES.AI_REMEDIATION]: mode('automated', 100)
        }),
        features: Object.freeze([
            '25 page credits / month',
            '3 projects',
            'Lighthouse, Axe, YellowLab + WPA core inspection',
            'Runtime, SEO/GEO, responsive UX and backend-surface checks',
            'TR/EN JSON + PDF/print reports',
            '30-day report history'
        ])
    }),
    Object.freeze({
        id: 'studio',
        name: 'Studio',
        priceUsd: 99,
        description: 'Automated whole-site quality, advanced browser evidence and passive security for teams.',
        limits: Object.freeze({ pageCredits: 150, projects: 15, seats: 5, retentionDays: 90, sourceAudits: 1, aiRemediations: 1000 }),
        entitlements: Object.freeze({
            [MODULES.CORE_AUDIT]: mode('automated'),
            [MODULES.RUNTIME]: mode('automated'),
            [MODULES.SEO]: mode('automated'),
            [MODULES.GEO]: mode('automated', 'advanced'),
            [MODULES.DESIGN]: mode('automated', 'advanced'),
            [MODULES.BACKEND_SURFACE]: mode('automated', 'advanced'),
            [MODULES.FULL_SITE_CRAWL]: mode('automated'),
            [MODULES.PERFORMANCE_PLUS]: mode('automated'),
            [MODULES.PASSIVE_SECURITY]: mode('automated'),
            [MODULES.SOURCE_AUDIT]: mode('automated', 1),
            [MODULES.AI_REMEDIATION]: mode('automated', 1000)
        }),
        features: Object.freeze([
            '150 page credits / month',
            '15 projects',
            'Everything in Signal + full-site crawl',
            'Advanced SEO/GEO, Visual UX and Performance Plus review',
            'Passive security + 1 source audit / month',
            'Report comparisons + shareable read-only reports',
            '90-day report history'
        ])
    }),
    Object.freeze({
        id: 'enterprise',
        name: 'Enterprise',
        priceUsd: 349,
        description: 'Highest-volume coverage with source, journey and signed report-webhook delivery.',
        limits: Object.freeze({ pageCredits: 500, projects: 50, seats: 15, retentionDays: 365, sourceAudits: 4, aiRemediations: 5000 }),
        entitlements: Object.freeze({
            [MODULES.CORE_AUDIT]: mode('automated'),
            [MODULES.RUNTIME]: mode('automated'),
            [MODULES.SEO]: mode('automated'),
            // Enterprise is contractually "Everything in Studio". Preserve
            // Studio's advanced depth instead of replacing it with an
            // unbounded/null value that the manifest and UI interpret as a
            // downgrade.
            [MODULES.GEO]: mode('automated', 'advanced'),
            [MODULES.DESIGN]: mode('automated', 'advanced'),
            [MODULES.BACKEND_SURFACE]: mode('automated', 'advanced'),
            [MODULES.FULL_SITE_CRAWL]: mode('automated'),
            [MODULES.PERFORMANCE_PLUS]: mode('automated'),
            [MODULES.PASSIVE_SECURITY]: mode('automated'),
            [MODULES.SOURCE_AUDIT]: mode('automated', 4),
            [MODULES.JOURNEY_TEST]: mode('automated'),
            [MODULES.API_WEBHOOKS]: mode('automated'),
            [MODULES.AI_REMEDIATION]: mode('automated', 5000)
        }),
        features: Object.freeze([
            '500 page credits / month',
            '50 projects',
            'Everything in Studio + 4 source audits / month',
            'Read-only journey tests + signed report webhooks',
            '365-day report history + workspace support tickets'
        ])
    })
]);

const ALL_PLANS = Object.freeze([FREE_PLAN, ...PLANS]);
const PLAN_SALES_MODES = Object.freeze({ free: 'internal', signal: 'self_serve', studio: 'self_serve', enterprise: 'contact' });

function publicPlan(plan) {
    return {
        id: plan.id,
        name: plan.name,
        priceUsd: plan.priceUsd,
        description: plan.description,
        salesMode: plan.salesMode || planSalesMode(plan.id),
        limits: plan.limits,
        features: plan.features,
        entitlements: plan.entitlements
    };
}

function getPlan(planId) {
    return ALL_PLANS.find((plan) => plan.id === planId) || null;
}

function planSalesMode(planId) {
    return PLAN_SALES_MODES[planId] || null;
}

module.exports = { ALL_PLANS, FREE_PLAN, MODULES, PLANS, PLAN_SALES_MODES, getPlan, planSalesMode, publicPlan };
