// THE GAMES A TEST NODE HOSTS (kanban #202): nextblock, as the reference launcher (src/main.js) hands it. A node given
// none hosts none (§0A.4), so every test node that opens rounds is handed this - or its own list, where a test is about
// which games a node hosts.
import { NEXTBLOCK } from '../../../nextblock/plugin/nextblock.js';

export const HOSTED = [NEXTBLOCK];
export { NEXTBLOCK_GAME_ID } from '../../../nextblock/plugin/nextblock.js';
