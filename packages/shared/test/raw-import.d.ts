// Vite's `?raw` import, which vitest honors. The shared package does not
// depend on `vite/client`, so the tests declare the one shape they use.
declare module "*?raw" {
  const source: string;
  export default source;
}
