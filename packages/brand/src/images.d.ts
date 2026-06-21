// Lets brand components import PNG assets as URLs. Vite (in every consuming
// app) resolves the import at bundle time and emits a hashed file.

declare module '*.png' {
  const src: string;
  export default src;
}
