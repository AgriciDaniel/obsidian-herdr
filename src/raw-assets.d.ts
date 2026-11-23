declare module "*.py" {
  const content: string;
  export default content;
}

declare module "*.cs" {
  const content: string;
  export default content;
}

declare module "*?raw" {
  const content: string;
  export default content;
}
