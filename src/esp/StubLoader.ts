import axios from 'axios';

interface StubDef {
  data: Buffer;
  text: Buffer;
  entry: number;
  text_start: number;
  data_start: number;
}

interface StubCache {
  [stubName: string]: StubDef;
}

const cache = {} as StubCache;

export default class StubLoader {
  stubsUrl: string

  constructor(stubsUrl?: string) {
    this.stubsUrl = stubsUrl || 'https://raw.githubusercontent.com/duinoapp/duinoapp-client/master/public/stubs';
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
      text_start: res.text_start,
      data_start: res.data_start,
    } as StubDef;

    cache[stubName] = stub;
    return stub;
  }
};