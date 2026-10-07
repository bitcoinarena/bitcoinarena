// THE CORE A LAUNCHED ROUND NAMES: the one this tree builds, measured now.
//
// Every launcher used to write thirty-two bytes of 1 as the core - one that does not
// exist - and nothing refused it, because nothing checked. A page now refuses a
// paying round on a core that is not on its known-good list (§5), so a
// launcher names the real one: `core/tools/hash-core.js`'s sorted-source hash
// of this checkout, never a remembered value.
import { fromHex } from '../../protocol/src/hash.js';
import { coreHashHex } from '../../nextblock/tools/hash-core.js';

export const CORE_HASH = fromHex(coreHashHex());
