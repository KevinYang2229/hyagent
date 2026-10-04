// App 不在 npm workspaces 內：套件一律從 app/node_modules 解析（根目錄是 React 18，不能被抓到），
// 只額外監看 shared/ 的原始碼。npm 會把部分相依套件巢狀安裝（例如 expo-router/node_modules），
// 所以不能關閉階層式查找；改成直接封鎖根目錄 node_modules，確保抓不到 React 18。
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, '../shared');
const config = getDefaultConfig(projectRoot);

config.watchFolders = [sharedRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];
const rootNodeModules = path.resolve(projectRoot, '../node_modules').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
config.resolver.blockList = [new RegExp(`^${rootNodeModules}[/\\\\].*`)];
config.resolver.extraNodeModules = { '@hyagent/shared': sharedRoot };

module.exports = config;
