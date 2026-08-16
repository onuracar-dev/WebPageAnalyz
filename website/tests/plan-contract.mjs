import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const sourcePath = new URL('../src/planCatalog.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const runnableSource = source
  .replace(/^export type .*$/m, '')
  .replace('export const PUBLIC_PLANS =', 'globalThis.PUBLIC_PLANS =')
  .replace(/\s+as const;\s*$/, ';');
const context = {};
vm.runInNewContext(runnableSource, context, { filename: fileURLToPath(sourcePath) });

const require = createRequire(import.meta.url);
const { FREE_PLAN, PLANS: backendPlans, PLAN_SALES_MODES } = require(fileURLToPath(new URL('../../backend/domain/plans.js', import.meta.url)));
const expectedPlans = [FREE_PLAN, ...backendPlans];
assert.equal(context.PUBLIC_PLANS.length, 4, 'public contract must contain Free plus the three paid packages');
assert.deepEqual(JSON.parse(JSON.stringify(context.PUBLIC_PLANS)), JSON.parse(JSON.stringify(expectedPlans)), 'public plan labels/copy/limits/entitlements must match backend/domain/plans.js');
assert.equal(new Set(context.PUBLIC_PLANS.map((plan) => plan.id)).size, 4, 'public plan ids must be unique');
const publicClaims = context.PUBLIC_PLANS.flatMap((plan) => [plan.description, ...plan.features]).join('\n');
assert.equal(/monitoring|white-label|expert-reviewed|priority support|service-level agreement|dedicated manager|uptime/i.test(publicClaims), false, 'public plans must not promise workflows or service levels that are not executable');
for (const plan of context.PUBLIC_PLANS) {
  assert.equal(plan.entitlements.monitoring, undefined, `${plan.id} must not expose a monitoring base entitlement`);
  assert.equal(plan.entitlements.white_label, undefined, `${plan.id} must not expose a white-label base entitlement`);
}
assert.equal(context.PUBLIC_PLANS.find((plan) => plan.id === 'enterprise').entitlements.expert_review, undefined, 'Expert Review is an explicit admin grant, not an Enterprise base entitlement');
assert.equal(PLAN_SALES_MODES.enterprise, 'contact', 'Enterprise must remain contact/invite-only');
assert.equal(PLAN_SALES_MODES.signal, 'self_serve');
assert.equal(PLAN_SALES_MODES.studio, 'self_serve');
console.log('plan contract parity: ' + context.PUBLIC_PLANS.map((plan) => plan.name).join(', '));
