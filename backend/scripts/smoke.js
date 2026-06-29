// Verifica che il core "si regga in piedi" senza un database:
// scoperta moduli, generazione tool OpenAI, parsing nomi tool.
import { registry } from '../src/modules/registry.js';
import { toolName, parseToolName } from '../src/modules/base.js';

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) {
    console.error('  ✗', msg);
    failures++;
  } else {
    console.log('  ✓', msg);
  }
};

console.log('Scoperta moduli…');
await registry.discover();

const keys = registry.list().map((m) => m.key).sort();
assert(keys.includes('email'), 'modulo email registrato');
assert(keys.includes('whatsapp'), 'modulo whatsapp registrato');
assert(keys.includes('connect-api'), 'modulo connect-api registrato');

const wa = registry.get('whatsapp');
assert(wa.notice?.includes('invio'), 'avviso versione iniziale WhatsApp presente');
assert(wa.capabilities.length === 1, 'WhatsApp espone solo una capability (send)');

assert(toolName('email', 'send') === 'email__send', 'toolName compone correttamente');
const parsed = parseToolName('connect-api__call_endpoint');
assert(parsed.moduleKey === 'connect-api' && parsed.capabilityName === 'call_endpoint', 'parseToolName scompone correttamente');

const email = registry.get('email');
const cfg = email.configSchema.safeParse({ smtps: [] });
assert(cfg.success, 'schema config email valido per smtps vuoti');

console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FALLITO (${failures})`);
process.exit(failures === 0 ? 0 : 1);
