import { launchFamilyBridge } from '../src/family-file-launcher.js';
try {
  launchFamilyBridge({bridgeTokenFile:'/etc/family-bridge/bridge-token',upstreamTokenFile:'/etc/family-bridge/gateway-token',groupsFile:'/etc/family-bridge/groups',ledgerPath:'/var/lib/family-bridge/ledger.sqlite',upstream:'http://127.0.0.1:19789/v1/responses'});
}catch{console.error('FAMILY_FILE_CONFIG');process.exitCode=1;}
