// import axios from 'axios';

/*
  Stub loaders are uploaded and run in-memory on the target device.
  They are usually more efficient than the default ROM loader and
  more up-to-date with the latest features and bug fixes.

  https://docs.espressif.com/projects/esptool/en/latest/esp32/esptool/flasher-stub.html

  The data for stub loaders can be quite large, and there are different ones
  for different esp chips, so we download it from the internet during run-time
  rather than including it in the package bundle.
*/

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
    this.stubsUrl = stubsUrl || 'https://raw.githubusercontent.com/espressif/esptool/master/esptool/targets/stub_flasher/';
    this.stubsUrl = this.stubsUrl.replace(/\/$/, '');
  }

  async loadStub(chipName: string) {
    const stubName = chipName.replace(/-/g, '').toLowerCase().replace('esp', '');
    if (cache[stubName]) {
      return cache[stubName];
    }
    let res = null as any;
    if (typeof window === 'undefined' && typeof fetch === 'undefined') {
      const { default: axios } = await import('axios');
      const response = await axios.get(`${this.stubsUrl}/stub_flasher_${stubName}.json`);
      res = response.data;
    } else {
      const response = await fetch(`${this.stubsUrl}/stub_flasher_${stubName}.json`);
      res = await response.json();
    }


    const stub = {
      data: Buffer.from(res.data, 'base64'),
      text: Buffer.from(res.text, 'base64'),
      entry: res.entry,
      textStart: res.text_start,
      dataStart: res.data_start,
    } as StubDef;

    cache[stubName] = stub;
    return stub;
  }
};