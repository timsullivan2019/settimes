import { readFileSync } from 'node:fs';

const URL = 'https://ra.co/graphql';
const HEADERS = {
  'content-type': 'application/json',
  'accept': '*/*',
  'ra-content-language': 'en',
  'user-agent': 'settimes.nyc/0.1 (+https://settimes.nyc; timsullivan2019@gmail.com)',
};
const BODY = JSON.parse(readFileSync('scripts/ra-query.json', 'utf8'));

const t0 = Date.now();
const res = await fetch(URL, {
  method: 'POST',
  headers: HEADERS,
  body: JSON.stringify(BODY),
});
const text = await res.text();

console.log('STATUS :', res.status, res.statusText);
console.log('MS     :', Date.now() - t0);
console.log('TYPE   :', res.headers.get('content-type'));
console.log('LENGTH :', text.length);
console.log('---------- FIRST 600 ----------');
console.log(text.slice(0, 600));
console.log('-------------------------------');

if (res.status !== 200) {
  console.error(`\n❌ FAIL — HTTP ${res.status}`);
  process.exit(1);
}
if (text.trimStart().startsWith('<')) {
  console.error('\n❌ FAIL — HTML returned, likely a bot challenge');
  process.exit(1);
}

let listings;
try {
  listings = JSON.parse(text).data.eventListingsWithBumps.eventListings;
} catch (e) {
  console.error('\n❌ FAIL — unexpected response shape:', e.message);
  process.exit(1);
}

const count = listings.data?.length ?? 0;
const total = listings.totalResults ?? 0;
console.log(`\nevents on page: ${count} | totalResults: ${total}`);

if (count === 0) {
  console.error('❌ FAIL — 200 but zero events');
  process.exit(1);
}
console.log('✅ PASS');
