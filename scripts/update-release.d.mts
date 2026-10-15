export function artifactKind(name: string, version: string): [string, string] | null;
export function buildManifest(directory: string, version: string, privatePem: string, publicBase64: string): { payload: string; signature: string };
