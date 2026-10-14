// Compares two layout snapshots from verify-mobile.mjs --layout, to show that a change
// meant for small screens left a (desktop) layout as it was.
// Usage: node scripts/compare-layout.mjs <beforeDir> <afterDir> [--widths=1024,1440]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const [before, after] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const widths = (process.argv.find(a => a.startsWith('--widths='))?.split('=')[1] || '1024,1440').split(',');
if (!before || !after) {
  console.error('Usage: node scripts/compare-layout.mjs <beforeDir> <afterDir> [--widths=1024,1440]');
  process.exit(2);
}

let changed = 0;
for (const file of readdirSync(before).filter(f => f.startsWith('layout-') && widths.some(w => f.endsWith(`-${w}.json`)))) {
  if (!existsSync(path.join(after, file))) {
    console.log(`MISSING ${file}`);
    changed++;
    continue;
  }
  const a = JSON.parse(readFileSync(path.join(before, file), 'utf8'));
  const b = JSON.parse(readFileSync(path.join(after, file), 'utf8'));
  // Elements are matched in document order by tag; a box that moved or resized by more than 1px counts.
  const diffs = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (!x || !y || x[1] !== y[1]) {
      diffs.push(`#${i} element differs: ${x ? `${x[1]}.${x[2]}` : '—'} -> ${y ? `${y[1]}.${y[2]}` : '—'}`);
      break; // the rest is shifted
    }
    const moved = [3, 4, 5, 6].some(k => Math.abs(x[k] - y[k]) > 1);
    if (moved) diffs.push(`#${i} ${x[1]}.${x[2].slice(0, 50)}  [${x.slice(3).join(',')}] -> [${y.slice(3).join(',')}]`);
  }
  if (diffs.length) {
    changed++;
    console.log(`CHANGED ${file} (${diffs.length} boxes)\n  ${diffs.slice(0, 12).join('\n  ')}`);
  } else {
    console.log(`same    ${file}`);
  }
}
console.log(`\n${changed} layouts changed.`);
process.exitCode = changed ? 1 : 0;
