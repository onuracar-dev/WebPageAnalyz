const { AppError } = require('../lib/errors');

function validateBody(schema) {
    return (request, _response, next) => {
        const result = schema.safeParse(request.body);
        if (!result.success) {
            const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')).filter(Boolean))];
            return next(new AppError(
                fields.length > 0 ? `Invalid request fields: ${fields.join(', ')}.` : 'The request body is invalid.',
                { status: 400, code: 'VALIDATION_ERROR' }
            ));
        }
        request.validatedBody = result.data;
        return next();
    };
}

module.exports = { validateBody };
