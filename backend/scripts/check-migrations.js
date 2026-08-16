const path = require('node:path');
const { readMigrationFiles, MIGRATION_DIRECTORY } = require('./migrate');

async function checkMigrations(directory = MIGRATION_DIRECTORY) {
    const files = await readMigrationFiles(directory);
    const seen = new Set();
    files.forEach((file, index) => {
        const match = /^(\d{3})_[a-z0-9][a-z0-9_-]*\.sql$/i.exec(file.filename);
        if (!match) throw new Error(`MIGRATION_FILENAME_INVALID: ${file.filename}`);
        const number = Number(match[1]);
        if (seen.has(number)) throw new Error(`MIGRATION_NUMBER_DUPLICATE: ${match[1]}`);
        seen.add(number);
        if (number !== index + 1) throw new Error(`MIGRATION_SEQUENCE_GAP: expected ${String(index + 1).padStart(3, '0')}, found ${match[1]}`);
        if (!file.contents.length) throw new Error(`MIGRATION_EMPTY: ${file.filename}`);
    });
    return files.map(({ filename, checksum }) => ({ filename, checksum }));
}

if (require.main === module) {
    checkMigrations().then((files) => {
        process.stdout.write(`${JSON.stringify({ migrationDirectory: path.relative(process.cwd(), MIGRATION_DIRECTORY), files }, null, 2)}\n`);
    }).catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { checkMigrations };
