// Modulo "Telefonico"
// Quando è attivo per un tenant, abilita la sezione "Numeri di telefono"
// (gestione/visualizzazione delle credenziali SIP e dei numeri DID).
// Il super admin lo abilita/disabilita per ogni tenant dalla sezione Moduli.
// È un modulo di accesso UI: non espone capability AI.

import { defineModule } from '../base.js';

export default defineModule({
  key: 'telefonico',
  name: 'Telefonico',
  description:
    'Abilita la sezione "Numeri di telefono" per gestire e consultare le ' +
    'credenziali SIP e i numeri DID collegati al tenant. ' +
    'Deve essere abilitato da un Super Admin.',
  defaultInstalled: false, // non attivo di default: lo abilita il super admin
  capabilities: [],        // nessuna capability AI — è un modulo di accesso UI
});
