const { AppError } = require('../lib/errors');

class AIProvider {
    constructor({ name, configured = false } = {}) {
        if (new.target === AIProvider) throw new TypeError('AIProvider is an abstract contract.');
        this.name = String(name || 'unknown');
        this.configured = Boolean(configured);
    }

    async generateRemediation(_finding, _context = {}) {
        throw new AppError('AI provider remediation is not implemented.', {
            status: 501,
            code: 'AI_PROVIDER_NOT_IMPLEMENTED'
        });
    }

    async generateExecutiveSummary(_input, _context = {}) {
        throw new AppError('AI provider executive summary is not implemented.', {
            status: 501,
            code: 'AI_PROVIDER_NOT_IMPLEMENTED'
        });
    }
}

function assertAIProvider(provider) {
    if (!provider || typeof provider.generateRemediation !== 'function' || typeof provider.generateExecutiveSummary !== 'function') {
        throw new TypeError('AI provider must implement generateRemediation and generateExecutiveSummary.');
    }
    return provider;
}

module.exports = { AIProvider, assertAIProvider };
