// Node loader hook that stubs `.png` imports during unit tests. Brand
// components like Sun and Logo import their PNG assets directly; in
// production Vite resolves those imports to hashed URLs at build time,
// but `node --test` has no such resolver and would otherwise throw
// ERR_UNKNOWN_FILE_EXTENSION. The stub stands in for the URL value —
// the tests inspect React props (src, alt, size), not the bytes behind
// the URL, so a placeholder is enough.
export async function load(url, context, nextLoad) {
  if (url.endsWith('.png')) {
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export default "test-png-stub";',
    };
  }
  return nextLoad(url, context);
}
