const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    {
        ignores: ['coverage/**', 'logs/**', 'node_modules/**']
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
                fetch: 'readonly',
                AbortController: 'readonly',
                DOMException: 'readonly'
            }
        },
        rules: {
            ...js.configs.recommended.rules,
            'no-console': 'off',
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
        }
    }
];
