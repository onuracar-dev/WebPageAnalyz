const fs = require('node:fs').promises;
const path = require('node:path');

const artifactPattern = /^(?:lighthouse_(?:desktop|mobile)|yellowlab|axe)_[0-9a-f-]+\.json$/i;

async function clearArtifacts(artifactDir) {
    await fs.mkdir(artifactDir, { recursive: true });
    const entries = await fs.readdir(artifactDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && artifactPattern.test(entry.name));
    const results = await Promise.allSettled(files.map((entry) => fs.unlink(path.join(artifactDir, entry.name))));
    return results.filter((result) => result.status === 'fulfilled').length;
}

module.exports = { clearArtifacts };
