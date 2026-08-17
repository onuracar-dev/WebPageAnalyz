const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs').promises;
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptsDir = path.join(__dirname, '..', 'scripts');
const postgresImage = 'postgres:17-alpine@sha256:d4bb0a8c1b7bb2e29f976d099e7bfb9a5d8858cffe9e46b35cd302cd1f1f8168';
const integrationEnabled = process.env.RUN_BOOTSTRAP_POSTGRES_INTEGRATION === '1';
const loginRoles = [
    ['wpa_runtime', 'POSTGRES_RUNTIME_PASSWORD'],
    ['wpa_migrator', 'POSTGRES_MIGRATOR_PASSWORD'],
    ['wpa_worker', 'POSTGRES_WORKER_PASSWORD'],
    ['wpa_maintenance', 'POSTGRES_MAINTENANCE_PASSWORD'],
    ['wpa_queue', 'POSTGRES_QUEUE_PASSWORD']
];

function docker(args, { allowFailure = false, timeout = 120_000 } = {}) {
    const result = spawnSync('docker', args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout
    });
    if (result.error) {
        throw new Error(`Docker invocation failed: ${result.error.code || result.error.name}`);
    }
    if (!allowFailure && result.status !== 0) {
        throw new Error(`Docker command failed with exit code ${result.status}`);
    }
    return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || ''
    };
}

function sentinel(label) {
    return `wpa-rc7-${label}-${crypto.randomBytes(24).toString('hex')}`;
}

function assertSecretsAbsent(output, secrets, label) {
    const hits = secrets.filter((secret) => output.includes(secret));
    assert.equal(hits.length, 0, `${label} exposed one or more password sentinels`);
}

function bootstrapArgs(networkName, databaseContainer, adminPassword, passwords) {
    const args = [
        'run', '--rm', '--network', networkName, '--user', '70:70',
        '--volume', `${scriptsDir}:/bootstrap:ro`,
        '--env', `POSTGRES_HOST=${databaseContainer}`,
        '--env', 'POSTGRES_PORT=5432',
        '--env', 'POSTGRES_DB=wpa_bootstrap_security',
        '--env', 'POSTGRES_ADMIN_USER=postgres',
        '--env', `POSTGRES_ADMIN_PASSWORD=${adminPassword}`
    ];
    for (const [role, variable] of loginRoles) {
        args.push('--env', `${variable}=${passwords.get(role)}`);
    }
    args.push('--entrypoint', '/bin/sh', postgresImage, '/bootstrap/bootstrap-roles.sh');
    return args;
}

function authenticate(networkName, databaseContainer, role, password) {
    const result = docker([
        'run', '--rm', '--network', networkName,
        '--env', `PGPASSWORD=${password}`,
        '--entrypoint', 'psql', postgresImage,
        '--no-psqlrc', '--host', databaseContainer, '--port', '5432',
        '--username', role, '--dbname', 'wpa_bootstrap_security',
        '--tuples-only', '--no-align', '--command', 'SELECT current_user;'
    ], { allowFailure: true });
    return result.status === 0 && result.stdout.trim() === role;
}

function authoritySnapshot(networkName, databaseContainer, adminPassword) {
    const roleNames = loginRoles.map(([role]) => `'${role}'`).concat("'wpa_owner'").join(', ');
    const query = `
SELECT 'role|' || rolname || '|' || rolcanlogin || '|' || rolsuper || '|' || rolcreatedb || '|' || rolcreaterole || '|' || rolinherit
FROM pg_roles WHERE rolname IN (${roleNames}) ORDER BY rolname;
SELECT 'db_connect|' || role_name || '|' || has_database_privilege(role_name, current_database(), 'CONNECT')
FROM unnest(ARRAY[${roleNames}]) AS role_name ORDER BY role_name;
SELECT 'schema|' || role_name || '|public_usage|' || has_schema_privilege(role_name, 'public', 'USAGE') || '|queue_usage|' || has_schema_privilege(role_name, 'wpa_queue', 'USAGE') || '|queue_create|' || has_schema_privilege(role_name, 'wpa_queue', 'CREATE')
FROM unnest(ARRAY[${roleNames}]) AS role_name ORDER BY role_name;
SELECT 'schema_owner|wpa_queue|' || pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'wpa_queue';
SELECT 'membership|' || parent.rolname || '|' || member.rolname
FROM pg_auth_members membership
JOIN pg_roles parent ON parent.oid = membership.roleid
JOIN pg_roles member ON member.oid = membership.member
WHERE parent.rolname IN (${roleNames}) OR member.rolname IN (${roleNames})
ORDER BY parent.rolname, member.rolname;
`;
    const result = docker([
        'run', '--rm', '--network', networkName,
        '--env', `PGPASSWORD=${adminPassword}`,
        '--entrypoint', 'psql', postgresImage,
        '--no-psqlrc', '--quiet', '--host', databaseContainer, '--port', '5432',
        '--username', 'postgres', '--dbname', 'wpa_bootstrap_security',
        '--tuples-only', '--no-align', '--command', query
    ]);
    return result.stdout.trim().split(/\r?\n/).filter(Boolean).join('\n');
}

test('bootstrap never renders password-bearing generated SQL', async () => {
    const [shell, sql] = await Promise.all([
        fs.readFile(path.join(scriptsDir, 'bootstrap-roles.sh'), 'utf8'),
        fs.readFile(path.join(scriptsDir, 'bootstrap-roles.sql'), 'utf8')
    ]);
    const generatedBlocks = [...sql.matchAll(/SELECT\s+format\([\s\S]*?;\s*\n\\gexec/g)].map((match) => match[0]);
    assert.ok(generatedBlocks.length > 0);
    for (const block of generatedBlocks) {
        assert.doesNotMatch(block, /PASSWORD\s+%L|:'(?:runtime|migrator|worker|maintenance|queue)_password'/i);
    }
    assert.doesNotMatch(sql, /\\(?:echo|qecho|warn)\b[^\n]*(?:password|_password)/i);
    assert.equal((sql.match(/^ALTER ROLE .* PASSWORD :'(?:runtime|migrator|worker|maintenance|queue)_password';$/gm) || []).length, 5);
    assert.match(shell, /^until PGPASSWORD="\$\{POSTGRES_ADMIN_PASSWORD\}" pg_isready\b/m);
    assert.match(shell, /^\s+--no-psqlrc \\$/m);
    assert.match(shell, /^\s+--set=ECHO=none \\$/m);
    assert.doesNotMatch(shell, /^set\s+-[^\n]*(?:x|v)/m);
});

test('bootstrap creates and rotates all login-role passwords without disclosure', {
    skip: !integrationEnabled && 'RUN_BOOTSTRAP_POSTGRES_INTEGRATION=1 is required',
    timeout: 240_000
}, async (t) => {
    const suffix = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const networkName = `wpa-bootstrap-security-${suffix}`;
    const databaseContainer = `wpa-bootstrap-postgres-${suffix}`;
    const adminPassword = sentinel('admin');
    const firstPasswords = new Map(loginRoles.map(([role]) => [role, sentinel(`first-${role}`)]));
    const secondPasswords = new Map(loginRoles.map(([role]) => [role, sentinel(`second-${role}`)]));
    const allSecrets = [adminPassword, ...firstPasswords.values(), ...secondPasswords.values()];
    let networkCreated = false;
    let containerCreated = false;

    t.after(() => {
        if (containerCreated) docker(['rm', '--force', databaseContainer], { allowFailure: true });
        if (networkCreated) docker(['network', 'rm', networkName], { allowFailure: true });
    });

    docker(['info']);
    docker(['network', 'create', networkName]);
    networkCreated = true;
    docker([
        'run', '--detach', '--name', databaseContainer, '--network', networkName,
        '--env', 'POSTGRES_DB=wpa_bootstrap_security',
        '--env', 'POSTGRES_USER=postgres',
        '--env', `POSTGRES_PASSWORD=${adminPassword}`,
        '--env', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
        postgresImage
    ]);
    containerCreated = true;

    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
        const result = docker([
            'exec', '--env', `PGPASSWORD=${adminPassword}`, databaseContainer,
            'pg_isready', '--username', 'postgres', '--dbname', 'wpa_bootstrap_security'
        ], { allowFailure: true });
        if (result.status === 0) {
            ready = true;
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(ready, true, 'disposable PostgreSQL did not become ready');

    const firstRun = docker(bootstrapArgs(networkName, databaseContainer, adminPassword, firstPasswords));
    assertSecretsAbsent(`${firstRun.stdout}\n${firstRun.stderr}`, allSecrets, 'first bootstrap run');
    for (const [role] of loginRoles) {
        assert.equal(authenticate(networkName, databaseContainer, role, firstPasswords.get(role)), true, `${role} rejected its first password`);
    }
    const firstSnapshot = authoritySnapshot(networkName, databaseContainer, adminPassword);
    for (const [role] of loginRoles) {
        assert.match(firstSnapshot, new RegExp(`^role\\|${role}\\|true\\|false\\|false\\|false\\|false$`, 'm'));
        assert.match(firstSnapshot, new RegExp(`^db_connect\\|${role}\\|true$`, 'm'));
    }
    assert.match(firstSnapshot, /^role\|wpa_owner\|false\|false\|false\|false\|false$/m);

    const secondRun = docker(bootstrapArgs(networkName, databaseContainer, adminPassword, secondPasswords));
    assertSecretsAbsent(`${secondRun.stdout}\n${secondRun.stderr}`, allSecrets, 'second bootstrap run');
    for (const [role] of loginRoles) {
        assert.equal(authenticate(networkName, databaseContainer, role, firstPasswords.get(role)), false, `${role} still accepted its old password`);
        assert.equal(authenticate(networkName, databaseContainer, role, secondPasswords.get(role)), true, `${role} rejected its rotated password`);
    }
    const secondSnapshot = authoritySnapshot(networkName, databaseContainer, adminPassword);
    assert.equal(secondSnapshot, firstSnapshot, 'role attributes, memberships or database/schema privileges changed during rotation');
});
