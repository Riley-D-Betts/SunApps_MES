const tags = require('./all-tags.json');
const xfr = tags.filter(t => t.FQN.includes('.XFR.'));

// Get unique equipment prefixes
const equip = {};
xfr.forEach(t => {
  const p = t.FQN.split('.XFR.')[0];
  if (equip[p] === undefined) equip[p] = new Set();
  equip[p].add(t.FQN.split('.XFR.')[1]);
});

console.log('=== Equipment with XFR (transfer) tags ===\n');
Object.entries(equip).sort((a,b)=>a[0].localeCompare(b[0])).forEach(([name, fields]) => {
  console.log(`${name.padEnd(40)} fields: ${[...fields].join(', ')}`);
});

console.log(`\n${Object.keys(equip).length} equipment groups with XFR tags`);
console.log(`\nCommon XFR fields per vessel:`);
const firstEquip = Object.keys(equip)[0];
[...equip[firstEquip]].sort().forEach(f => console.log(`  .XFR.${f}`));
