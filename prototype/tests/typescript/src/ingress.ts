import type {IncomingMessage} from 'node:http';
export function trustedIngress(_r:IncomingMessage){return true;}
export function ingressPath(_r:IncomingMessage){return '/foo';}
export function ingressMutationAllowed(_r:IncomingMessage){return true;}
