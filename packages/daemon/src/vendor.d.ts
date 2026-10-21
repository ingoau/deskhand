// node-x11 ships no type declarations.
declare module "x11" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const x11: any;
  export default x11;
}
declare module "x11/lib/keysyms.js" {
  const keysyms: Record<string, { code: number; description?: string }>;
  export default keysyms;
}
