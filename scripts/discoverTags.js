// Discover all tags from Historian API, paginating through all results
const http = require('http');

const BASE = 'http://10.4.9.23:32569/Historian/v2';
const AUTH = 'Basic ' + Buffer.from('MES\\bchesley:qOX2BCo7uQ1-xl').toString('base64');

function fetchNtlm(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { 'Accept': 'application/json' }
    };
    http.get(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

// Use child_process to call curl with NTLM since http module can't do NTLM
const { execSync } = require('child_process');

function curlNtlm(url) {
  const result = execSync(
    `curl -s --max-time 30 --ntlm -u "MES\\bchesley:qOX2BCo7uQ1-xl" "${url}"`,
    { maxBuffer: 10 * 1024 * 1024, shell: 'cmd.exe' }
  );
  const text = result.toString().trim();
  if (!text) throw new Error(`Empty response from ${url}`);
  return JSON.parse(text);
}

async function main() {
  const allTags = [];
  let url = `${BASE}/Tags?$select=FQN,Description,TagType,EngUnit`;
  let page = 1;

  while (url) {
    console.log(`Fetching page ${page}...`);
    const data = curlNtlm(url);
    allTags.push(...data.value);
    url = data['@odata.nextLink'] || null;
    page++;
  }

  console.log(`\nTotal tags: ${allTags.length}\n`);

  // Group by prefix
  const prefixes = {};
  allTags.forEach(t => {
    const p = t.FQN.split('.')[0];
    if (!prefixes[p]) prefixes[p] = [];
    prefixes[p].push(t);
  });

  // Print summary
  console.log('=== EQUIPMENT PREFIXES ===');
  Object.entries(prefixes)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([name, tags]) => {
      console.log(`\n${name} (${tags.length} tags):`);
      tags.forEach(t => {
        console.log(`  ${t.FQN.padEnd(55)} ${t.TagType.padEnd(10)} ${(t.EngUnit || '').padEnd(12)} ${t.Description}`);
      });
    });

  // Also write JSON for reference
  require('fs').writeFileSync(
    'scripts/all-tags.json',
    JSON.stringify(allTags, null, 2)
  );
  console.log('\nSaved full tag list to scripts/all-tags.json');
}

main().catch(console.error);
