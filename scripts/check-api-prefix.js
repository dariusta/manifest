/**
 * Guards the single definition of `API_KEY_PREFIX`.
 *
 * This once compared two independent literals, back when the backend and a
 * separate plugin package each declared `mnfst_`. The backend now re-exports
 * the shared constant, so there is nothing left to compare — and the drift the
 * old check watched for can only come back by someone re-declaring the literal
 * in the backend. That is what this asserts instead: `shared` owns the value,
 * and the backend forwards it.
 */
const fs = require('fs');

const SHARED = 'packages/shared/src/api-key.ts';
const BACKEND = 'packages/backend/src/common/constants/api-key.constants.ts';

const DECLARATION = /export\s+const\s+API_KEY_PREFIX\s*=\s*['"]([^'"]+)['"]/;
const RE_EXPORT =
  /export\s*\{[^}]*\bAPI_KEY_PREFIX\b[^}]*\}\s*from\s*['"]manifest-shared['"]/;

/**
 * @returns {{prefix: string} | {error: string}} the prefix, or why the sources
 * no longer have exactly one definition of it.
 */
function checkApiPrefix(sharedSrc, backendSrc) {
  const declared = DECLARATION.exec(sharedSrc);
  if (!declared) {
    return { error: `Could not find the API_KEY_PREFIX declaration in ${SHARED}` };
  }
  // A second literal is the failure mode worth catching: two sources of truth
  // drift, and the prefix is what every agent key is matched against.
  const backendDeclares = DECLARATION.exec(backendSrc);
  if (backendDeclares) {
    return {
      error:
        `${BACKEND} re-declares API_KEY_PREFIX as "${backendDeclares[1]}".\n` +
        `It must re-export the one in ${SHARED} instead, so the prefix has a single source of truth.`,
    };
  }
  if (!RE_EXPORT.test(backendSrc)) {
    return {
      error:
        `${BACKEND} does not re-export API_KEY_PREFIX from 'manifest-shared'.\n` +
        `Expected: export { API_KEY_PREFIX } from 'manifest-shared';`,
    };
  }
  return { prefix: declared[1] };
}

function main() {
  const result = checkApiPrefix(
    fs.readFileSync(SHARED, 'utf8'),
    fs.readFileSync(BACKEND, 'utf8'),
  );
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(
    `OK: API_KEY_PREFIX="${result.prefix}" declared once in shared and re-exported by the backend.`,
  );
}

if (require.main === module) {
  main();
}

module.exports = { checkApiPrefix, SHARED, BACKEND };
