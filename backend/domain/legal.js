const LEGAL_DOCUMENTS = Object.freeze({
    terms: Object.freeze({ id: 'terms', version: '1.0', path: '/terms', acceptanceRequired: true }),
    privacy: Object.freeze({ id: 'privacy', version: '1.0', path: '/privacy', acceptanceRequired: false }),
    kvkk: Object.freeze({ id: 'kvkk', version: '1.0', path: '/kvkk', acceptanceRequired: false }),
    acceptableUse: Object.freeze({ id: 'acceptable_use', version: '1.0', path: '/acceptable-use', acceptanceRequired: true }),
    refund: Object.freeze({ id: 'refund', version: '1.0', path: '/refund', acceptanceRequired: true }),
    subprocessors: Object.freeze({ id: 'subprocessors', version: '1.0', path: '/subprocessors', acceptanceRequired: false }),
    targetAuthorization: Object.freeze({ id: 'target_authorization', version: '1.0', acceptanceRequired: true })
});

const SIGNUP_ACCEPTANCE = Object.freeze({
    termsVersion: LEGAL_DOCUMENTS.terms.version,
    acceptableUseVersion: LEGAL_DOCUMENTS.acceptableUse.version
});

const CHECKOUT_ACCEPTANCE = Object.freeze({
    termsVersion: LEGAL_DOCUMENTS.terms.version,
    refundPolicyVersion: LEGAL_DOCUMENTS.refund.version
});

function publicLegalVersions() {
    return Object.fromEntries(Object.entries(LEGAL_DOCUMENTS).map(([key, value]) => [key, {
        id: value.id,
        version: value.version,
        ...(value.path ? { path: value.path } : {})
    }]));
}

module.exports = { LEGAL_DOCUMENTS, SIGNUP_ACCEPTANCE, CHECKOUT_ACCEPTANCE, publicLegalVersions };
