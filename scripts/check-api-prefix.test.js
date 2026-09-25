const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { checkApiPrefix, SHARED, BACKEND } = require('./check-api-prefix.js');

const SHARED_OK = "export const API_KEY_PREFIX = 'mnfst_' as const;\n";
const BACKEND_OK = "export { API_KEY_PREFIX } from 'manifest-shared';\n";

test('accepts one declaration in shared plus a backend re-export', () => {
  assert.deepEqual(checkApiPrefix(SHARED_OK, BACKEND_OK), { prefix: 'mnfst_' });
});

test('accepts a re-export listed alongside other names', () => {
  const backend = "export { API_KEY_PREFIX, OTHER } from 'manifest-shared';\n";
  assert.deepEqual(checkApiPrefix(SHARED_OK, backend), { prefix: 'mnfst_' });
});

test('rejects a shared file with no declaration', () => {
  const result = checkApiPrefix('export const SOMETHING_ELSE = 1;\n', BACKEND_OK);
  assert.match(result.error, /Could not find the API_KEY_PREFIX declaration/);
});

test('rejects a second literal in the backend', () => {
  const backend = "export const API_KEY_PREFIX = 'mnfst2_' as const;\n";
  const result = checkApiPrefix(SHARED_OK, backend);
  assert.match(result.error, /re-declares API_KEY_PREFIX as "mnfst2_"/);
});

test('rejects a backend that re-exports from somewhere other than shared', () => {
  const backend = "export { API_KEY_PREFIX } from './elsewhere';\n";
  const result = checkApiPrefix(SHARED_OK, backend);
  assert.match(result.error, /does not re-export API_KEY_PREFIX/);
});

test('the real files in this repo satisfy the check', () => {
  const result = checkApiPrefix(
    fs.readFileSync(SHARED, 'utf8'),
    fs.readFileSync(BACKEND, 'utf8'),
  );
  assert.equal(result.error, undefined);
  assert.equal(result.prefix, 'mnfst_');
});
