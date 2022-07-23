import axios from 'axios';

interface StubDef {
  data: Buffer;
  text: Buffer;
  entry: number;
  textStart: number;
  dataStart: number;
}

interface StubCache {
  [stubName: string]: StubDef;
}

const cache = {} as StubCache;

export default class StubLoader {
  stubsUrl: string

  constructor(stubsUrl?: string) {
    // TODO; Change branch from esp-support to main
    this.stubsUrl = stubsUrl || 'https://raw.githubusercontent.com/duinoapp/upload-multitool/esp-support/src/esp/stubs/';
    this.stubsUrl = this.stubsUrl.replace(/\/$/, '');
  }

  async loadStub(chipName: string) {
    const stubName = chipName.replace(/-/g, '').toLowerCase();
    if (cache[stubName]) {
      return cache[stubName];
    }
    const { data: res } = await axios.get(`${this.stubsUrl}/${stubName}.json`);

    const stub = {
      data: Buffer.from(res.data, 'base64'),
      text: Buffer.from(res.text, 'base64'),
      entry: res.entry,
      textStart: res.textStart,
      dataStart: res.dataStart,
    } as StubDef;

    cache[stubName] = stub;
    return stub;
  }
};