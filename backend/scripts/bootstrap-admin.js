require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const { bootstrapFirstAdmin, provisionBootstrapToken } = require('../auth/bootstrap');

function parseArguments(argv) {
    const values = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith('--')) throw new Error(`Unknown argument: ${argument}`);
        const [key, inlineValue] = argument.slice(2).split('=', 2);
        if (key === 'init-token' && inlineValue === undefined) {
            values[key] = true;
            continue;
        }
        const value = inlineValue ?? argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}.`);
        values[key] = value;
    }
    return values;
}

async function main() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
    if (!process.env.BOOTSTRAP_ADMIN_TOKEN) throw new Error('BOOTSTRAP_ADMIN_TOKEN must be supplied only for this one-time command.');
    const argumentsMap = parseArguments(process.argv.slice(2));
    if (argumentsMap['init-token']) {
        const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
        try {
            await provisionBootstrapToken({ pool, token: process.env.BOOTSTRAP_ADMIN_TOKEN });
            process.stdout.write('Provisioned the one-time administrator bootstrap token. Run the command again without --init-token to consume it.\n');
        } finally {
            await pool.end();
        }
        return;
    }
    const required = ['user-id', 'email', 'reason'];
    for (const key of required) if (!argumentsMap[key]) throw new Error(`--${key} is required.`);

    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
        const result = await bootstrapFirstAdmin({
            pool,
            userId: argumentsMap['user-id'],
            email: argumentsMap.email,
            token: process.env.BOOTSTRAP_ADMIN_TOKEN,
            reason: argumentsMap.reason
        });
        process.stdout.write(`Bootstrapped ${result.email} as ${result.role}. Request: ${result.requestId}\n`);
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error.code || 'BOOTSTRAP_FAILED'}: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { parseArguments };
