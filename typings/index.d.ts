interface IntelHexResult {
  data: Buffer;
  startSegmentAddress: number | null;
  startLinearAddress: number | null;
}

declare module 'intel-hex' {
  export function parse(data: string | Buffer, bufferSize?: number): IntelHexResult;
}


declare module 'pako';
declare module 'crypto-js/md5';
declare module 'crypto-js/enc-base64';
