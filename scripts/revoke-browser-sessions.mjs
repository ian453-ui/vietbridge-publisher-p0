import {join,isAbsolute} from 'node:path';
import {BrowserSessionStore} from '../src/browser-session-store.js';
const root=process.argv[2];
if(!isAbsolute(root||''))throw Error('ABSOLUTE_EXISTING_DATA_DIR_REQUIRED');
new BrowserSessionStore(join(root,'publisher-sessions')).revokeAll();
console.log('Browser sessions revoked; publishing history and credentials unchanged.');
