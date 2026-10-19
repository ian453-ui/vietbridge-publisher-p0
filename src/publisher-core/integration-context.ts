import type { IncomingMessage } from 'node:http';

// An in-process capability, not a header supplied by the external caller.
export const integrationContext = Symbol('publisher.integration.context');
export type IntegrationContext = {
  id: string; name: string; contentRoot: string; operatorAccountId: string;
  publisherAccountId: string; platforms: string[];
  nonce?: string;
};
export type IntegrationBridge = {
  context(req: IncomingMessage): IntegrationContext;
  batchAllowed(context: IntegrationContext, batchId: string): boolean;
  batchIds(context: IntegrationContext): string[];
  register(context: IntegrationContext, batchId: string): void;
};
export type BrowserResourceGuard = {acquire(port:number,owner:string,pending:()=>boolean,reconcile?:boolean):()=>void};
