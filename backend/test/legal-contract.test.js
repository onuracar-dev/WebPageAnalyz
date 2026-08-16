const test = require('node:test');
const assert = require('node:assert/strict');
const { LEGAL_DOCUMENTS, SIGNUP_ACCEPTANCE, CHECKOUT_ACCEPTANCE, publicLegalVersions } = require('../domain/legal');

test('launch legal versions distinguish contractual acceptance from privacy notices', () => {
    assert.equal(LEGAL_DOCUMENTS.terms.acceptanceRequired, true);
    assert.equal(LEGAL_DOCUMENTS.acceptableUse.acceptanceRequired, true);
    assert.equal(LEGAL_DOCUMENTS.refund.acceptanceRequired, true);
    assert.equal(LEGAL_DOCUMENTS.privacy.acceptanceRequired, false);
    assert.equal(LEGAL_DOCUMENTS.kvkk.acceptanceRequired, false);
    assert.deepEqual(SIGNUP_ACCEPTANCE, { termsVersion: '1.0', acceptableUseVersion: '1.0' });
    assert.deepEqual(CHECKOUT_ACCEPTANCE, { termsVersion: '1.0', refundPolicyVersion: '1.0' });
    assert.equal(publicLegalVersions().subprocessors.path, '/subprocessors');
});
