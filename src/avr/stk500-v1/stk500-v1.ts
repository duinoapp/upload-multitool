// based on https://github.com/jacobrosenthal/js-stk500v1 (MIT license)
// converted to typescript/modernised by mrfrase3 (GPL-3.0 license)

import { SerialPort } from 'serialport/dist/index.d';
import { setDTRRTS } from '../../util/serial-helpers';
import asyncTimeout from '../../util/async-timeout';

interface STK500v1Options {
  quiet?: boolean;
}

interface SendCommandOptions {
  cmd: Buffer | number[];
  timeout?: number;
  responseData?: Buffer;
  responseLength?: number;
}

interface DeviceOptions {
  devicecode?: number,
  revision?: number,
  progtype?: number,
  parmode?: number,
  polling?: number,
  selftimed?: number,
  lockbytes?: number,
  fusebytes?: number,
  flashpollval1?: number,
  flashpollval2?: number,
  eeprompollval1?: number,
  eeprompollval2?: number,
  pagesizehigh?: number,
  pagesizelow?: number,
  eepromsizehigh?: number,
  eepromsizelow?: number,
  flashsize4?: number,
  flashsize3?: number,
  flashsize2?: number,
  flashsize1?: number,
}

interface BootloadOptions {
  signature: Buffer,
  pageSize?: number;
  timeout?: number;
}

const statics = {
  CMD_STK_GET_SYNC: 0x30,
  CMD_STK_SET_DEVICE: 0x42,
  CMD_STK_ENTER_PROGMODE: 0x50,
  CMD_STK_LOAD_ADDRESS: 0x55,
  CMD_STK_PROG_PAGE: 0x64,
  CMD_STK_LEAVE_PROGMODE: 0x51,
  CMD_STK_READ_SIGN: 0x75,
  CMD_STK_READ_PAGE: 0x74,

  SYNC_CRC_EOP: 0x20,

  RES_STK_OK: 0x10,
  RES_STK_INSYNC: 0x14,
  RES_STK_NOSYNC: 0x15,

  OK_RESPONSE: Buffer.from([0x14, 0x10]),
};
statics.OK_RESPONSE = Buffer.from([statics.RES_STK_INSYNC, statics.RES_STK_OK]);

export default class STK500v1 {
  opts: STK500v1Options;
  quiet: boolean;
  serial: SerialPort;

  constructor(serial: SerialPort, opts: STK500v1Options) {
    this.opts = opts || {};
    this.quiet = this.opts.quiet || false;
    this.serial = serial;
  }

  log (...args: any[]) {
    if (this.quiet) return;
    console.log(...args);
  }

  receiveData(timeout = 0, responseLength: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const startingBytes = [
        statics.RES_STK_INSYNC,
      ];
      let buffer = Buffer.alloc(0);
      let started = false;
      let timeoutId = null as NodeJS.Timeout | null;
      let handleChunk = (data: Buffer) => {};
      const finished = (err?: Error) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        // VALIDATE TERMINAL BYTE?
        this.serial.removeListener('data', handleChunk);
        if (err) {
          reject(err);
        } else {
          resolve(buffer);
        }
      };
      handleChunk = (data: Buffer) => {
        let index = 0;
        while (!started && index < data.length) {
          const byte = data[index];
          if (startingBytes.indexOf(byte) !== -1) {
            data = data.slice(index, data.length - index);
            started = true;
          }
          index += 1;
        }
        if (started) {
          buffer = Buffer.concat([buffer, data]);
        }
        if (buffer.length > responseLength) {
          // or ignore after
          return finished(new Error(`buffer overflow ${buffer.length} > ${responseLength}`));
        }
        if (buffer.length == responseLength) {
          finished();
        }
      };
      if (timeout && timeout > 0) {
        timeoutId = setTimeout(() => {
          timeoutId = null;
          finished(new Error(`receiveData timeout after ${timeout}ms`));
        }, timeout);
      }
      this.serial.on('data', handleChunk);
    });
  }

  async sendCommand(opt: SendCommandOptions): Promise<Buffer|null> {
    const timeout = opt.timeout || 0;
    const startingBytes = [
      statics.RES_STK_INSYNC,
      statics.RES_STK_NOSYNC
    ];
    let responseData = Buffer.from(opt.responseData || []);
    let responseLength = opt.responseLength || responseData.length;
    let response = Buffer.alloc(0);
    let cmd = Array.isArray(opt.cmd)
      ? Buffer.from(opt.cmd.concat(statics.SYNC_CRC_EOP))
      : opt.cmd;
  
    try {
      await this.serial.write(cmd);
    } catch (err: any) {
      throw new Error(`Error writing "${cmd.toString('hex')}" to serial port: ${err.message}`);
    }
    if (!responseLength) return null;
    try {
      response = await this.receiveData(timeout, responseLength);
    } catch (err: any) {
      this.log(`Error receiving data after sending "${cmd.toString('hex')}"`);
      throw err;
    }
    if (responseLength > 0 && !responseData.equals(response)) {
      throw new Error(`Response data mismatch: expected "${responseData.toString('hex')}" got "${response.toString('hex')}"`);
    }
    return response;
  }


  async sync(attempts = 3, timeout = 400, ogAttempts = attempts): Promise<Buffer|null> {
    this.log(`sync ${attempts}`);
    try {
      const res = await this.sendCommand({
        cmd: [
          statics.CMD_STK_GET_SYNC
        ],
        responseData: statics.OK_RESPONSE,
        timeout,
      });
      this.log(`sync complete after ${ogAttempts - attempts + 1} attempt: ${res?.toString('hex')}`);
      return res;
    } catch (err) {
      if (attempts <= 1) {
        throw err;
      }
      return await this.sync(attempts - 1, timeout, ogAttempts);
    }
  }

  verifySignature (signature: Buffer, timeout = 400): Promise<Buffer|null> {
    this.log('verify signature');
    const expectedResponse = Buffer.concat([
      Buffer.from([statics.RES_STK_INSYNC]),
      signature,
      Buffer.from([statics.RES_STK_OK])
    ]);
    return this.sendCommand({
      cmd: [
        statics.CMD_STK_READ_SIGN
      ],
      responseData: expectedResponse,
      responseLength: expectedResponse.length,
      timeout,
    });
  }

  getSignature (timeout = 400): Promise<Buffer|null> {
    this.log('get signature');
    return this.sendCommand({
      cmd: [
        statics.CMD_STK_READ_SIGN
      ],
      responseLength: 5,
      timeout,
    });
  }

  setOptions(options: DeviceOptions, timeout = 400): Promise<Buffer|null> {
    this.log('set device');
    
    return this.sendCommand({
      cmd: [
        statics.CMD_STK_SET_DEVICE,
        options.devicecode || 0,
        options.revision || 0,
        options.progtype || 0,
        options.parmode || 0,
        options.polling || 0,
        options.selftimed || 0,
        options.lockbytes || 0,
        options.fusebytes || 0,
        options.flashpollval1 || 0,
        options.flashpollval2 || 0,
        options.eeprompollval1 || 0,
        options.eeprompollval2 || 0,
        options.pagesizehigh || 0,
        options.pagesizelow || 0,
        options.eepromsizehigh || 0,
        options.eepromsizelow || 0,
        options.flashsize4 || 0,
        options.flashsize3 || 0,
        options.flashsize2 || 0,
        options.flashsize1 || 0
      ],
      responseData: statics.OK_RESPONSE,
      timeout,
    });
  }

  enterProgrammingMode (timeout = 400): Promise<Buffer|null> {
    this.log('enter programming mode');
    return this.sendCommand({
      cmd: [
        statics.CMD_STK_ENTER_PROGMODE
      ],
      responseData: statics.OK_RESPONSE,
      timeout,
    });
  }

  loadAddress(useaddr: number, timeout = 400): Promise<Buffer|null> {
    this.log("load address");
    var addr_low = useaddr & 0xff;
    var addr_high = (useaddr >> 8) & 0xff;
    return this.sendCommand({
      cmd: [
        statics.CMD_STK_LOAD_ADDRESS,
        addr_low,
        addr_high
      ],
      responseData: statics.OK_RESPONSE,
      timeout,
    });
  }

  loadPage(writeBytes: Buffer, timeout = 400): Promise<Buffer|null> {
    this.log('load page');
    const size = writeBytes.length;

    const cmd = Buffer.concat([
      Buffer.from([
        statics.CMD_STK_PROG_PAGE,
        (size >> 8) & 0xff,
        size & 0xff,
        0x46,
      ]),
      writeBytes,
      Buffer.from([statics.SYNC_CRC_EOP])
    ]);
    return this.sendCommand({
      cmd,
      responseData: statics.OK_RESPONSE,
      timeout,
    });
  }

  async upload(hex: Buffer, pageSize: number, timeout = 400) {
    this.log('upload');

    const pages = (new Array(Math.ceil(hex.length / pageSize))).fill(0);

    await pages.reduce(async (promise, _, i) => {
      await promise;
      const pageaddr = i * pageSize;
      const useaddr = pageaddr >> 1;
      const writeBytes = hex.subarray(pageaddr, (hex.length > pageSize ? (pageaddr + pageSize) : hex.length - 1));
      await this.loadAddress(useaddr, timeout);
      await this.loadPage(writeBytes, timeout);
      this.log(`uploaded page ${i + 1} of ${pages.length}`);
      await asyncTimeout(4);
    }, Promise.resolve());
    this.log('upload complete');
  }

  exitProgrammingMode(timeout = 400): Promise<Buffer|null> {
    this.log('exiting programming mode');
    return this.sendCommand({
      cmd: [
        statics.CMD_STK_LEAVE_PROGMODE
      ],
      responseData: statics.OK_RESPONSE,
      timeout,
    });
  }

  async verify(hex: Buffer, pageSize: number, timeout = 400) {
    this.log('verify');

    const pages = (new Array(Math.ceil(hex.length / pageSize))).fill(0);

    await pages.reduce(async (promise, _, i) => {
      await promise;
      const pageaddr = i * pageSize;
      const useaddr = pageaddr >> 1;
      const writeBytes = hex.subarray(pageaddr, (hex.length > pageSize ? (pageaddr + pageSize) : hex.length - 1));
      await this.loadAddress(useaddr, timeout);
      await this.verifyPage(writeBytes, pageSize, timeout);
      this.log(`verified page ${i + 1} of ${pages.length}`);
      asyncTimeout(4);
    }, Promise.resolve());
    this.log('verification complete');
  }

  verifyPage(writeBytes: Buffer, pageSize: number, timeout: number) {
    this.log("verify page");
    const expectedResponse = Buffer.concat([
      Buffer.from([statics.RES_STK_INSYNC]),
      writeBytes,
      Buffer.from([statics.RES_STK_OK])
    ]);

    const size = Math.min(pageSize, writeBytes.length);

    return this.sendCommand({
      cmd: [
        statics.CMD_STK_READ_PAGE,
        (size >> 8) & 0xff,
        size & 0xff,
        0x46
      ],
      responseData: expectedResponse,
      responseLength: expectedResponse.length,
      timeout,
    }); 
  }

  async reset() {
    this.log('reset');
    await setDTRRTS(this.serial, false);
    await asyncTimeout(250);
    await setDTRRTS(this.serial, true);
    await asyncTimeout(50);
  }

  async bootload(hex: Buffer, opt: BootloadOptions) {
    this.log('bootload');
    opt.pageSize = opt.pageSize || 256;

    const parameters = {
      pagesizehigh: (opt.pageSize << 8) & 0xff,
      pagesizelow: opt.pageSize & 0xff
    }

    await this.reset();
    await this.sync(3, opt.timeout);
    await this.sync(3, opt.timeout);
    await this.sync(3, opt.timeout);
    await this.verifySignature(opt.signature, opt.timeout);
    await this.setOptions(parameters, opt.timeout);
    await this.enterProgrammingMode(opt.timeout);
    await this.upload(hex, opt.pageSize, opt.timeout);
    await this.verify(hex, opt.pageSize, opt.timeout);
    await this.exitProgrammingMode(opt.timeout);

    this.log('bootload complete');
  }
}
