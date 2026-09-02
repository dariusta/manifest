const fs = require('fs');

// The prefix may be either declared as a literal or re-exported from the shared
// package. The backend constant module is currently a pure re-export, so a
// literal-only regex matched nothing and this check failed unconditionally.
const LITERAL = /API_KEY_PREFIX\s*=\s*['"]([^'"]+)['"]/;
const REEXPORT = /export\s*\{[^}]*\bAPI_KEY_PREFIX\b[^}]*\}\s*from\s*['"]([^'"]+)['"]/;

const SHARED_DECLARATION = 'packages/shared/src/api-key.ts';

/**
 * Resolve the value a package effectively sees. A re-export from the shared
 * package resolves to the single shared declaration; anything else is a local
 * literal that could drift, which is exactly what this check exists to catch.
 */
function resolvePrefix(file) {
  const src = fs.readFileSync(file, 'utf8');

  const literal = LITERAL.exec(src);
  if (literal) return { value: literal[1], via: file };

  const reexport = REEXPORT.exec(src);
  if (reexport) {
    // Only 'manifest-shared' is a known indirection; a re-export from anywhere
    // else is a new source of truth this script has not been taught about.
    if (reexport[1] !== 'manifest-shared') {
      throw new Error(`${file} re-exports API_KEY_PREFIX from unexpected module "${reexport[1]}"`);
    }
    const shared = LITERAL.exec(fs.readFileSync(SHARED_DECLARATION, 'utf8'));
    if (!shared) {
      throw new Error(
        `${file} re-exports from manifest-shared, but ${SHARED_DECLARATION} declares no literal`,
      );
    }
    return { value: shared[1], via: `${file} -> ${SHARED_DECLARATION}` };
  }

  throw new Error(`Could not extract API_KEY_PREFIX from ${file}`);
}

let backend;
let plugin;
try {
  backend = resolvePrefix('packages/backend/src/common/constants/api-key.constants.ts');
  plugin = resolvePrefix(SHARED_DECLARATION);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

if (backend.value !== plugin.value) {
  console.error(
    `MISMATCH: backend="${backend.value}" (${backend.via}) plugin="${plugin.value}" (${plugin.via})`,
  );
  process.exit(1);
}

console.log(`OK: API_KEY_PREFIX="${backend.value}" (backend via ${backend.via})`);
