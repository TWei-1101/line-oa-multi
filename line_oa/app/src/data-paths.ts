/** One path contract for the runtime queue and its pre-spawn interlock. */
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

export function bridgeDatabasePath(bridgeRoot:string):string {
  return join(bridgeRoot,'openclaw.sqlite');
}
export function multiDataPaths(dataDir=DATA_DIR):{rootDir:string;openclawDb:string} {
  const rootDir=join(dataDir,'multi');
  return {rootDir,openclawDb:bridgeDatabasePath(rootDir)};
}
