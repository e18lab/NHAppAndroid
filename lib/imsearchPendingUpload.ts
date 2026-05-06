export type ImsearchPendingFile =
  | { kind: "web"; file: File }
  | { kind: "native"; uri: string; name: string; type: string };

let pending: ImsearchPendingFile | null = null;

export function setImsearchPendingFile(p: ImsearchPendingFile): void {
  pending = p;
}

export function takeImsearchPendingFile(): ImsearchPendingFile | null {
  const x = pending;
  pending = null;
  return x;
}
