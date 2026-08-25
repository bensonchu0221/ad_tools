import 'dotenv/config';
import { ingestAccount } from '../src/tools/mgidsource/ingest.js';
const id = process.argv[2] || '860504';
const name = process.argv[3] || '里山十二食';
const r = await ingestAccount(id, name);
console.log(JSON.stringify(r, null, 2));
process.exit(0);
