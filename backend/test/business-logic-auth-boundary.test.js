const test = require('node:test');
const assert = require('node:assert/strict');
const {
    accountStateAllowsSensitiveMutation,
    isOrganizationMutationPath,
    isSensitiveVerificationIdentifier,
    userIsBanned,
    workspaceIsSuspended
} = require('../auth/better-auth');

test('auth boundary treats banned or missing account state as non-authoritative for sensitive flows', () => {
    assert.equal(accountStateAllowsSensitiveMutation({ state: 'active' }), true);
    assert.equal(accountStateAllowsSensitiveMutation({ state: 'banned' }), false);
    assert.equal(accountStateAllowsSensitiveMutation({ status: 'banned' }), false);
    assert.equal(accountStateAllowsSensitiveMutation(null), false);
    assert.equal(userIsBanned({ banned: true }), true);
});

test('verification consume guard only covers reset-password values', () => {
    assert.equal(isSensitiveVerificationIdentifier('reset-password:token-1'), true);
    assert.equal(isSensitiveVerificationIdentifier('email-verification:token-1'), false);
    assert.equal(isSensitiveVerificationIdentifier('reset-password:'), true);
    assert.equal(isSensitiveVerificationIdentifier(null), false);
});

test('organization mutation matcher excludes read-only Better Auth organization routes', () => {
    assert.equal(isOrganizationMutationPath('/organization/update'), true);
    assert.equal(isOrganizationMutationPath('/organization/accept-invitation'), true);
    assert.equal(isOrganizationMutationPath('/organization/set-active'), true);
    assert.equal(isOrganizationMutationPath('/organization/list'), false);
    assert.equal(isOrganizationMutationPath('/organization/get-full-organization'), false);
    assert.equal(isOrganizationMutationPath('/sign-in/email'), false);
    assert.equal(workspaceIsSuspended({ state: 'suspended' }), true);
});
