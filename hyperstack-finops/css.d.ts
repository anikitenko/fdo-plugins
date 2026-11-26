declare module "*.css" {
  const styles: Record<string, import("@anikitenko/fdo-sdk").DOMStyleMap>;
  export default styles;
}
