// Compiled-in provider registry. Providers self-register at import time via a
// factory (name -> createProvider). NOT dynamic .so/plugin loading (fragile).
// Adding a provider = one import + one register() call in index.js.

const factories = new Map();

export function register(name, createProvider) {
  if (factories.has(name)) throw new Error(`provider already registered: ${name}`);
  factories.set(name, createProvider);
}

export function has(name) {
  return factories.has(name);
}

export function names() {
  return [...factories.keys()];
}

export function create(name) {
  const f = factories.get(name);
  if (!f) throw new Error(`unknown provider: ${name}`);
  return f();
}
