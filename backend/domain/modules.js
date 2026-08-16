const TARGET_ACCESS = Object.freeze({
    PUBLIC_LINK: 'public_link',
    VERIFIED_ORIGIN: 'verified_origin',
    NOT_APPLICABLE: 'not_applicable'
});

const DEFINITIONS = Object.freeze({
    core_audit: { trigger: 'page_scan', default: true, targetAccess: TARGET_ACCESS.PUBLIC_LINK },
    runtime: { trigger: 'page_scan', default: true, targetAccess: TARGET_ACCESS.PUBLIC_LINK },
    seo: { trigger: 'page_scan', default: true, targetAccess: TARGET_ACCESS.PUBLIC_LINK },
    geo: { trigger: 'page_scan', default: true, targetAccess: TARGET_ACCESS.PUBLIC_LINK },
    design: { trigger: 'page_scan', default: true, targetAccess: TARGET_ACCESS.PUBLIC_LINK },
    backend_surface: { trigger: 'page_scan', default: true, targetAccess: TARGET_ACCESS.PUBLIC_LINK },
    full_site_crawl: { trigger: 'site_scan', default: true, targetAccess: TARGET_ACCESS.VERIFIED_ORIGIN },
    performance_plus: { trigger: 'page_scan', default: true, targetAccess: TARGET_ACCESS.PUBLIC_LINK },
    passive_security: { trigger: 'site_scan', default: true, targetAccess: TARGET_ACCESS.VERIFIED_ORIGIN },
    source_audit: { trigger: 'source_input', default: false, targetAccess: TARGET_ACCESS.NOT_APPLICABLE },
    journey_test: { trigger: 'journey', default: false, targetAccess: TARGET_ACCESS.VERIFIED_ORIGIN },
    expert_review: { trigger: 'review_request', default: false, targetAccess: TARGET_ACCESS.NOT_APPLICABLE },
    monitoring: { trigger: 'schedule', default: false, targetAccess: TARGET_ACCESS.VERIFIED_ORIGIN },
    white_label: { trigger: 'report', default: false, targetAccess: TARGET_ACCESS.NOT_APPLICABLE },
    api_webhooks: { trigger: 'delivery', default: false, targetAccess: TARGET_ACCESS.NOT_APPLICABLE },
    ai_remediation: { trigger: 'ai_generation', default: false, targetAccess: TARGET_ACCESS.NOT_APPLICABLE }
});

function defaultScanModules(plan) {
    return Object.keys(plan.entitlements).filter((moduleId) => DEFINITIONS[moduleId]?.default && ['page_scan', 'site_scan'].includes(DEFINITIONS[moduleId].trigger));
}

function requiresVerifiedTarget(moduleId) {
    return DEFINITIONS[moduleId]?.targetAccess === TARGET_ACCESS.VERIFIED_ORIGIN;
}

module.exports = { TARGET_ACCESS, DEFINITIONS, defaultScanModules, requiresVerifiedTarget };
