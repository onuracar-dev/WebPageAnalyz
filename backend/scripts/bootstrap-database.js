require('dotenv').config({ quiet: true });

const { runMigrations } = require('./migrate');
const { bootstrapQueue } = require('./bootstrap-queue');

async function bootstrapDatabase(options = {}) {
    const migration = await runMigrations(options);
    const queue = await bootstrapQueue(options);
    return { migration, queue };
}

if (require.main === module) {
    bootstrapDatabase().then(({ migration, queue }) => {
        process.stdout.write(`Database bootstrap complete: ${migration.latest || 'no app migrations'}; queue ${queue.schema}.\n`);
    }).catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { bootstrapDatabase };
