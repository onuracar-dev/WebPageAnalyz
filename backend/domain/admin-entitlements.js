const { MODULES } = require('./plans');

const NON_EXECUTABLE_ADMIN_MODULE_IDS = new Set([
    MODULES.MONITORING,
    MODULES.WHITE_LABEL
]);
const ADMIN_GRANTABLE_MODULE_IDS = Object.freeze(Object.values(MODULES)
    .filter((moduleId) => !NON_EXECUTABLE_ADMIN_MODULE_IDS.has(moduleId)));
const adminGrantableModuleIdSet = new Set(ADMIN_GRANTABLE_MODULE_IDS);

function isAdminGrantableModule(moduleId) {
    return adminGrantableModuleIdSet.has(moduleId);
}

module.exports = { ADMIN_GRANTABLE_MODULE_IDS, isAdminGrantableModule };
