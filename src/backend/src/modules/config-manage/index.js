// Modulo "Gestisci configurazione"
// Quando è attivo per un tenant, l'admin del tenant può accedere a:
//   - Dati da raccogliere
//   - Moduli (solo lettura — non può attivarli/disattivarli)
//   - Embed
// Il super admin può abilitarlo/disabilitarlo per ogni tenant dalla sezione Moduli.
// L'admin del tenant non può attivarlo da solo.

import { defineModule } from '../base.js';

export default defineModule({
  key: 'config-manage',
  name: 'Gestisci configurazione',
  description:
    'Permette agli admin del tenant di accedere alla configurazione avanzata: ' +
    'dati da raccogliere, stato moduli (sola lettura) ed embed widget. ' +
    'Deve essere abilitato da un Super Admin.',
  defaultInstalled: false, // non attivo di default: il super admin deve abilitarlo
  capabilities: [],        // nessuna capability AI — è un modulo di accesso UI
});
