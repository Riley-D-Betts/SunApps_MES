const tags = require('./all-tags.json');
const xfr = tags.filter(t => t.FQN.includes('.XFR'));
const groups = {};
xfr.forEach(t => {
  const p = t.FQN.split('.XFR')[0];
  if (groups[p] === undefined) groups[p] = [];
  groups[p].push(t);
});
Object.entries(groups).sort((a,b)=>a[0].localeCompare(b[0])).forEach(([name, tags]) => {
  console.log(`\n=== ${name} (${tags.length} tags) ===`);
  tags.forEach(t => console.log(`  ${t.FQN.padEnd(60)} ${t.TagType.padEnd(10)} ${(t.EngUnit||'').padEnd(8)} ${t.Description}`));
});
console.log(`\nTotal XFR tags: ${xfr.length}`);
