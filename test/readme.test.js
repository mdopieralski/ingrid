import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('every package.json script is described in the README Scripts table', () => {
  const scripts = Object.keys(JSON.parse(read('../package.json')).scripts);
  const section = read('../README.md').split('### Scripts')[1]?.split('\n---')[0] ?? '';
  // Table rows only: "| `name` / `other` | description |" → the names in the first cell.
  const documented = section
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .flatMap((line) => [...line.split('|')[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]));

  assert.deepEqual(
    scripts.filter((name) => !documented.includes(name)),
    [],
    'scripts missing from the README',
  );
  assert.deepEqual(
    documented.filter((name) => !scripts.includes(name)),
    [],
    'README lists scripts that do not exist',
  );
});
