import { createFamilyBridgeServer } from '../src/family-bridge-server.js';
const token=process.env.FAMILY_BRIDGE_TOKEN, groups=(process.env.FAMILY_BRIDGE_GROUPS ?? '').split(',').filter(Boolean), ledgerPath=process.env.FAMILY_BRIDGE_LEDGER;
if (!token || !groups.length || !ledgerPath) throw new Error('FAMILY_BRIDGE_CONFIG_REQUIRED');
const port=Number(process.env.FAMILY_BRIDGE_PORT ?? '18791'); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('FAMILY_BRIDGE_PORT');
createFamilyBridgeServer({token,groups,ledgerPath,upstream:process.env.FAMILY_UPSTREAM,upstreamToken:process.env.FAMILY_UPSTREAM_TOKEN}).listen(port,'127.0.0.1');
