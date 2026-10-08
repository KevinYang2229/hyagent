// App 位在 mobile/ 工作區：套件從 apps/store/node_modules 與 mobile/node_modules 解析，
// 共用核心用 @hyagent/app-core/<路徑> 對到 packages/app-core/src，shared 直接監看 repo 根目錄的原始碼。
// repo 根目錄的 node_modules 是網頁版的 React 18，必須封鎖；npm 會把部分相依套件巢狀安裝
// （例如 expo-router/node_modules），所以不能關閉階層式查找。
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const repoRoot = path.resolve(workspaceRoot, '..');
const sharedRoot = path.resolve(repoRoot, 'shared');
const coreSrc = path.resolve(workspaceRoot, 'packages/app-core/src');
const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot, sharedRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules'), path.resolve(workspaceRoot, 'node_modules')];
const rootNodeModules = path.resolve(repoRoot, 'node_modules').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
config.resolver.blockList = [new RegExp(`^${rootNodeModules}[/\\\\].*`)];
config.resolver.extraNodeModules = { '@hyagent/shared': sharedRoot };

const CORE_PREFIX = '@hyagent/app-core/';
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith(CORE_PREFIX)) {
    return context.resolveRequest(context, path.join(coreSrc, moduleName.slice(CORE_PREFIX.length)), platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
