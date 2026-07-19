const { z } = require('zod');

const limitedText = (max) => z.string().trim().min(1).max(max);

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

module.exports = { analyzeSchema, executiveSummarySchema, solveSchema };
