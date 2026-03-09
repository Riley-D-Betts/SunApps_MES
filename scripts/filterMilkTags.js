const tags = require('./all-tags.json');

const milk = tags.filter(t => {
  const fqn = t.FQN.toLowerCase();
  return fqn.includes('separator') || fqn.includes('rawmilk') || fqn.includes('intake')
    || fqn.includes('cream') || fqn.includes('skim') || fqn.includes('coldmilk')
    || fqn.includes('bulkmilk') || fqn.includes('silo');
});

const groups = {};
milk.forEach(t => {
  const p = t.FQN.split('.')[0];
  if (!(p in groups)) groups[p] = [];
  groups[p].push(t);
});

Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0])).forEach(([name, tags]) => {
  console.log(`\n=== ${name} (${tags.length} tags) ===`);
  tags.forEach(t => {
    console.log(`  ${t.FQN.padEnd(55)} ${t.TagType.padEnd(10)} ${(t.EngUnit || '').padEnd(12)} ${t.Description}`);
  });
});

console.log(`\nTotal milk-related tags: ${milk.length}`);
