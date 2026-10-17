import { DOMAIN_IDS, DOMAIN_DISCIPLINE } from '../core/domain/types.js';
let total = 0;
for (const id of DOMAIN_IDS) {
  console.log(`  ${id}: ${DOMAIN_DISCIPLINE[id].length} 条`);
  total += DOMAIN_DISCIPLINE[id].length;
}
console.log(`  合计 ${total} 条`);
