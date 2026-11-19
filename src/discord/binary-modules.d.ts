declare module "*.otf" {
  const font: ArrayBuffer;
  export default font;
}

declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
