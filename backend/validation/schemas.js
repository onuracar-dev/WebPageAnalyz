const { z } = require('zod');
const { SIGNUP_ACCEPTANCE, CHECKOUT_ACCEPTANCE, LEGAL_DOCUMENTS } = require('../domain/legal');
const { ADMIN_GRANTABLE_MODULE_IDS } = require('../domain/admin-entitlements');

const limitedText = (max) => z.string().trim().min(1).max(max);
const adminGrantableModuleSchema = z.enum(ADMIN_GRANTABLE_MODULE_IDS);

const analyzeSchema = z.object({
    url: limitedText(2048)
}).strict();

const issueSchema = z.object({
    id: limitedText(256).optional(),
    title: limitedText(300),
    description: z.string().trim().max(10_000).optional().default(''),
    source: z.string().trim().max(100).optional().default('Unknown'),
    snippet: z.string().max(20_000).optional(),
    displayValue: z.string().trim().max(500).optional(),
    score: z.number().finite().min(0).max(100).optional()
}).strict();

const solveSchema = z.object({ issue: issueSchema }).strict();

const scoreSchema = z.number().finite().min(0).max(100);
const executiveSummarySchema = z.object({
    scores: z.object({
        performance: scoreSchema,
        seo: scoreSchema,
        accessibility: scoreSchema,
        bestPractices: scoreSchema
    }).strict()
}).strict();

const localeSchema = z.enum(['tr', 'en']);
const projectSchema = z.object({
    name: limitedText(120),
    url: limitedText(2048),
    locale: localeSchema.optional().default('en'),
    authorizationAttested: z.literal(true),
    authorizationVersion: z.literal(LEGAL_DOCUMENTS.targetAuthorization.version),
    additionalSubdomains: z.array(limitedText(2048)).max(20).optional().default([])
}).strict();
const journeyStepSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('goto'), path: limitedText(500), timeoutMs: z.number().int().min(100).max(15_000).optional() }).strict(),
    z.object({ action: z.literal('click'), selector: limitedText(500), timeoutMs: z.number().int().min(100).max(15_000).optional() }).strict(),
    z.object({ action: z.literal('expectVisible'), selector: limitedText(500), timeoutMs: z.number().int().min(100).max(15_000).optional() }).strict(),
    z.object({ action: z.literal('expectText'), selector: limitedText(500), value: limitedText(500), timeoutMs: z.number().int().min(100).max(15_000).optional() }).strict(),
    z.object({ action: z.literal('waitFor'), timeoutMs: z.number().int().min(50).max(2_000) }).strict()
]);
const journeySchema = z.object({ name: limitedText(120), steps: z.array(journeyStepSchema).min(2).max(20) }).strict().superRefine((journey, context) => {
    const assertions = journey.steps.filter((step) => ['expectVisible', 'expectText'].includes(step.action));
    if (!assertions.length || (journey.steps.length === 1 && assertions[0]?.action === 'expectVisible' && assertions[0]?.selector === 'body')) {
        context.addIssue({ code: 'custom', message: 'Journey Test requires a real navigation/action plus an explicit UI assertion; body-only smoke is not journey evidence.', path: ['steps'] });
    }
});
const scanSchema = z.object({
    projectId: limitedText(128),
    urls: z.array(limitedText(2048)).min(1).max(500).optional(),
    additionalUrls: z.array(limitedText(2048)).max(500).optional().default([]),
    locale: localeSchema.optional().default('en'),
    externalProviderConsent: z.boolean().optional().default(false),
    modules: z.array(limitedText(80)).max(30).optional(),
    journey: journeySchema.optional()
}).strict();
const verificationSchema = z.object({
    method: z.enum(['dns', 'html_file', 'meta_tag', 'operator', 'basic_auth']).optional().default('operator')
}).strict();
const planAssignmentSchema = z.object({ planId: z.enum(['free', 'signal', 'studio', 'enterprise']), reason: limitedText(500), confirm: z.literal(true) }).strict();
const adminReauthSchema = z.object({ password: z.string().min(1).max(1_024), totpCode: z.string().regex(/^\d{6}$/) }).strict();
const adminWebAuthnConfirmSchema = z.object({}).strict();
const adminRoleAssignmentSchema = z.object({
    role: z.enum(['super_admin', 'admin', 'moderator', 'support']),
    active: z.boolean(),
    reason: limitedText(500),
    confirm: z.literal(true)
}).strict();
const adminRecoveryUseSchema = z.object({
    code: z.string().trim().regex(/^WPA-[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/),
    password: z.string().min(1).max(1_024),
    totpCode: z.string().regex(/^\d{6}$/),
    confirm: z.literal(true)
}).strict();
const operatorCompletionSchema = z.object({
    notes: z.string().trim().max(20_000).optional().default(''),
    reportPatch: z.record(z.string(), z.unknown()).optional(),
    reason: limitedText(500),
    confirm: z.literal(true)
}).strict();
const entitlementSchema = z.object({
    executionMode: z.enum(['automated', 'operator_assisted', 'disabled']),
    limit: z.union([z.string().trim().max(80), z.number().finite().nonnegative(), z.null()]).optional(),
    reason: limitedText(500),
    confirm: z.literal(true)
}).strict();
const checkoutSchema = z.object({
    planId: z.enum(['signal', 'studio', 'enterprise']),
    accepted: z.literal(true),
    recurringAcknowledged: z.literal(true),
    termsVersion: z.literal(CHECKOUT_ACCEPTANCE.termsVersion),
    refundPolicyVersion: z.literal(CHECKOUT_ACCEPTANCE.refundPolicyVersion)
}).strict();
const legalAcceptanceSchema = z.object({
    accepted: z.literal(true),
    termsVersion: z.literal(SIGNUP_ACCEPTANCE.termsVersion),
    acceptableUseVersion: z.literal(SIGNUP_ACCEPTANCE.acceptableUseVersion)
}).strict();
const redeemSchema = z.object({ code: z.string().trim().min(6).max(64).regex(/^[A-Za-z0-9_-]+$/) }).strict();
const adminReasonSchema = z.object({ reason: limitedText(500), confirm: z.literal(true) }).strict();
const adminWebhookReplaySchema = z.object({ workspaceId: limitedText(128).optional(), reason: limitedText(500), confirm: z.literal(true) }).strict();
const adminDeletionExecuteSchema = z.object({ reason: limitedText(500), confirm: z.literal(true), confirmExecution: z.literal(true), dryRun: z.boolean().optional().default(true) }).strict();
const adminCreditAdjustmentSchema = z.object({
    kind: z.enum(['page', 'ai']),
    amount: z.number().int().min(-100_000).max(100_000).refine((value) => value !== 0, 'Credit adjustment cannot be zero.'),
    reason: limitedText(500),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    confirm: z.literal(true)
}).strict();
const adminEntitlementGrantSchema = z.object({
    planId: z.enum(['signal', 'studio', 'enterprise']).nullable().optional(),
    moduleId: adminGrantableModuleSchema.nullable().optional(),
    executionMode: z.enum(['automated', 'operator_assisted', 'disabled']).nullable().optional(),
    limit: z.union([z.string().trim().max(80), z.number().finite().nonnegative(), z.null()]).optional(),
    expiresAt: z.string().datetime({ offset: true }),
    reason: limitedText(500),
    confirm: z.literal(true)
}).strict().superRefine((value, context) => {
    if (!value.planId && !value.moduleId) context.addIssue({ code: 'custom', message: 'A temporary plan or module grant is required.', path: ['planId'] });
    if (value.moduleId && !value.executionMode) context.addIssue({ code: 'custom', message: 'A module grant requires an execution mode.', path: ['executionMode'] });
});
const adminRedeemCreateSchema = z.object({
    code: z.string().trim().min(6).max(64).regex(/^[A-Za-z0-9_-]+$/),
    active: z.boolean().optional().default(true),
    startsAt: z.string().datetime({ offset: true }).nullable().optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    durationDays: z.number().int().min(1).max(366).nullable().optional(),
    maxGlobalRedemptions: z.number().int().min(1).max(1_000_000),
    maxPerWorkspace: z.number().int().min(1).max(100).optional().default(1),
    temporaryPlan: z.enum(['signal', 'studio', 'enterprise']).nullable().optional(),
    bonusPageCredits: z.number().int().min(0).max(100_000).optional().default(0),
    bonusAiCredits: z.number().int().min(0).max(1_000_000).optional().default(0),
    entitlementOverrides: z.partialRecord(adminGrantableModuleSchema, z.object({
        executionMode: z.enum(['automated', 'operator_assisted', 'disabled']),
        limit: z.union([z.string().trim().max(80), z.number().finite().nonnegative(), z.null()]).optional()
    }).strict()).optional().default({}),
    adminNote: z.string().trim().max(2_000).optional().default(''),
    reason: limitedText(500),
    confirm: z.literal(true)
}).strict();
const adminRedeemMutationSchema = z.object({ reason: limitedText(500), confirm: z.literal(true) }).strict();
const adminScanMutationSchema = z.object({ reason: limitedText(500), confirm: z.literal(true), idempotencyKey: limitedText(128) }).strict();
const aiRemediationSchema = z.object({ refresh: z.boolean().optional().default(false) }).strict();
const shareSchema = z.object({
    expiresInDays: z.number().int().refine((value) => [7, 30, 90].includes(value), 'Share expiry must be 7, 30, or 90 days.').optional().default(30)
}).strict();
const workspaceSettingsSchema = z.object({
    workspaceName: limitedText(120),
    defaultLocale: localeSchema,
    notifyScanComplete: z.boolean(),
    notifyHighPriority: z.boolean(),
    weeklyDigest: z.boolean()
}).strict();
const workspaceDeletionSchema = z.object({ confirm: z.literal(true) }).strict();
const webhookIntegrationSchema = z.object({
    url: z.string().trim().url().max(2048),
    secret: z.string().min(24).max(256).optional()
}).strict();
const expertReviewRequestSchema = z.object({ pageUrls: z.array(limitedText(2048)).min(1).max(25), idempotencyKey: limitedText(128) }).strict();
const expertDecisionSchema = z.object({
    decision: z.enum(['accepted', 'rejected', 'edited']), priority: z.enum(['p0', 'p1', 'p2', 'p3']),
    rationale: z.string().trim().max(5_000).optional().default(''),
    edits: z.object({ title: limitedText(300).optional(), description: z.string().trim().max(10_000).optional(), severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(), remediation: z.string().trim().max(10_000).optional(), owner: z.string().trim().max(120).optional() }).strict().optional(),
    reason: limitedText(500),
    confirm: z.literal(true)
}).strict().superRefine((value, context) => { if (value.decision === 'rejected' && !value.rationale) context.addIssue({ code: 'custom', message: 'A rejection rationale is required.', path: ['rationale'] }); if (value.decision === 'edited' && !value.edits) context.addIssue({ code: 'custom', message: 'Edited findings require allowed edits.', path: ['edits'] }); });
const roadmapSchema = z.object({
    items: z.array(z.object({ title: limitedText(200), description: z.string().trim().max(2_000).optional().default(''), owner: z.string().trim().max(120).optional().default('Unassigned'), effort: z.enum(['small', 'medium', 'large']), horizon: z.enum(['now', 'next', 'later']), findingFingerprints: z.array(limitedText(128)).max(50).default([]) }).strict()).max(100),
    reason: limitedText(500),
    confirm: z.literal(true)
}).strict();
const engineLabRunSchema = z.object({
    targetUrl: limitedText(2048),
    engineIds: z.array(z.enum(['lighthouse', 'axe', 'yellowLab', 'playwright', 'wpaPage', 'crawler', 'performancePlus', 'advancedGeo', 'visualUx', 'journey', 'zapBaseline', 'osvScanner'])).min(1).max(12),
    journey: journeySchema.optional(),
    crawlerLimit: z.number().int().min(1).max(200).optional().default(25)
}).strict();
const supportPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
const supportStatusSchema = z.enum(['open', 'pending', 'in_progress', 'waiting_customer', 'resolved', 'closed']);
const supportTicketSchema = z.object({
    category: z.enum(['analysis', 'account', 'billing', 'security', 'general']).optional().default('general'),
    subject: limitedText(200),
    body: z.string().trim().min(1).max(20_000).optional(),
    message: z.string().trim().min(1).max(20_000).optional(),
    context: z.string().trim().max(2_000).optional(),
    targetUrl: z.string().trim().url().max(2_048).refine((value) => {
        try {
            const parsed = new URL(value);
            return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
        } catch { return false; }
    }, 'Target URL must use credential-free HTTP or HTTPS.').optional(),
    reportId: limitedText(128).optional(),
    priority: supportPrioritySchema.optional().default('normal')
}).strict().superRefine((value, context) => {
    if (!value.body && !value.message) context.addIssue({ code: 'custom', message: 'A support message is required.', path: ['body'] });
}).transform((value) => ({ ...value, body: value.body || value.message || '' }));
const supportReplySchema = z.object({ body: z.string().trim().min(1).max(20_000), visibility: z.enum(['customer', 'public', 'internal']).optional() }).strict();
const supportAdminUpdateSchema = z.object({
    status: supportStatusSchema.optional(),
    priority: supportPrioritySchema.optional(),
    assignedTo: z.string().trim().min(1).max(128).nullable().optional(),
    assigneeId: z.string().trim().min(1).max(128).nullable().optional()
}).strict().refine((value) => Object.keys(value).length > 0, { message: 'At least one support ticket field is required.' }).transform((value) => ({
    ...value,
    ...(value.status === 'waiting_customer' ? { status: 'pending' } : {}),
    ...(Object.hasOwn(value, 'assigneeId') && !Object.hasOwn(value, 'assignedTo') ? { assignedTo: value.assigneeId } : {})
}));
const supportCustomerTransitionSchema = z.object({ status: z.enum(['open', 'closed']) }).strict();

module.exports = {
    analyzeSchema,
    executiveSummarySchema,
    solveSchema,
    projectSchema,
    scanSchema,
    journeySchema,
    verificationSchema,
    planAssignmentSchema,
    adminReauthSchema,
    adminWebAuthnConfirmSchema,
    adminRoleAssignmentSchema,
    adminRecoveryUseSchema,
    operatorCompletionSchema,
    entitlementSchema,
    checkoutSchema,
    legalAcceptanceSchema,
    redeemSchema,
    adminReasonSchema,
    adminWebhookReplaySchema,
    adminDeletionExecuteSchema,
    adminCreditAdjustmentSchema,
    adminGrantableModuleSchema,
    adminEntitlementGrantSchema,
    adminRedeemCreateSchema,
    adminRedeemMutationSchema,
    adminScanMutationSchema,
    aiRemediationSchema,
    shareSchema,
    workspaceSettingsSchema,
    workspaceDeletionSchema,
    webhookIntegrationSchema,
    expertReviewRequestSchema,
    expertDecisionSchema,
    roadmapSchema,
    engineLabRunSchema,
    supportTicketSchema,
    supportReplySchema,
    supportAdminUpdateSchema,
    supportCustomerTransitionSchema
};
