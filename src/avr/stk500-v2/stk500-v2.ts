import { SerialPort } from 'serialport/dist/index.d';
import { SerialPortPromise } from '../../serialport/serialport-promise';

import statics from './constants';
import { setDTRRTS } from '../../util/serial-helpers';
import asyncTimeout from '../../util/async-timeout';
import { StdOut } from '../../index';

interface STK500v2Options {
  quiet?: boolean;
  stdout?: StdOut;
}

interface SendCommandOptions {
  cmd: Buffer | number[];
  timeout?: number;
  responseData?: Buffer;
  responseLength?: number;
  ignoreResponse?: boolean;
  checkOK?: boolean;
}

interface ProgramOptions {
  signature: Buffer,
  pageSize?: number;
  timeout?: number;
  stabDelay?: number;
  cmdexeDelay?: number;
  synchLoops?: number;
  byteDelay?: number;
  pollValue?: number;
  pollIndex?: number;
}

const defaultProgramOptions = {
  pageSize: 256,
  timeout: 0xc8,
  stabDelay: 0x64,
  cmdexeDelay: 0x19,
  synchLoops: 0x20,
  byteDelay: 0x00,
  pollValue: 0x53,
  pollIndex: 0x03,
};

export default class STK500v2 {
  opts: STK500v2Options;
  quiet: boolean;
  serial: SerialPortPromise;
  sequence: number;

  constructor(serial: SerialPort | SerialPortPromise, opts: STK500v2Options) {
    this.opts = opts;
    this.serial = serial instanceof SerialPortPromise ? serial : new SerialPortPromise(serial);
    this.quiet = opts.quiet || false;
    this.sequence = 0;
  }

  log(...args: any[]) {
    if (this.quiet) return;
    this.opts.stdout?.write(`${args.join(' ')}\r\n`);
  }

  receiveData(timeout = 0, responseLength?: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let state = 0;
      const messageLen = Buffer.from([0,0]);
      let length = 0;
      let writeHead = 0;
      let checksum = 0;
      let buffer = Buffer.alloc(0);
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
        } else if (responseLength && length !== responseLength) {
          reject(new Error(`Unexpected response length, ${length}, expected ${responseLength}`));
        } else {
          resolve(buffer);
        }
      };
      handleChunk = (data: Buffer) => {
        for (let i = 0; i < data.length; i += 1) {
          const byte = data[i];
          checksum ^= byte;
          switch (state) {
            case 0: // sSTART
              if (byte === statics.MESSAGE_START) {
                checksum = statics.MESSAGE_START;
                state = 1;
              }
            break;
            case 1: // sSEQNUM
              if (byte === this.sequence) {
                this.sequence = (this.sequence + 1) % 256;
                state = 2;
              }
            break;
            case 2: // sSIZE1
            case 3: // sSIZE2
              messageLen[state - 2] = byte;
              length = messageLen.readUInt16BE(0);
              state += 1;
            break;
            case 4: // sTOKEN
              if (byte === statics.TOKEN) {
                state = 5; // sDATA
                buffer = Buffer.alloc(length);
              } else {
                state = 0; // sSTART
              }
            break;
            case 5: // sDATA
              if (writeHead < length) {
                buffer[writeHead] = byte;
              } else {
                this.log(`overflowed buffer (${writeHead}): ${byte}`);
                return finished(new Error('overflowed buffer'));
              }
              if (writeHead === 0 && byte === statics.ANSWER_CKSUM_ERROR) {
                this.log('previous packet sent with wrong checksum');
                return finished(new Error('previous packet sent with wrong checksum'));
              }
              writeHead += 1;
              if (writeHead === length) {
                state = 6; // sCSUM
              }
            break;
            case 6: // sCSUM 👀
              if (checksum === 0) {
                state = 7; // sEND
              } else {
                this.log('checksum error', checksum);
                return finished(new Error('checksum error'));
              }
              return finished();
            default:
              this.log('invalid state', state);
              return finished(new Error('invalid state'));
          }
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

  async sendCommand(opt: SendCommandOptions): Promise<Buffer> {
    const timeout = opt.timeout || 0;
    let responseData = Buffer.from(opt.responseData || []);
    let responseLength = opt.responseLength || responseData?.length;
    let response = Buffer.alloc(0);
    let cmd = Array.isArray(opt.cmd)
      ? Buffer.from(opt.cmd)
      : opt.cmd;

    const messageLen = Buffer.from([0,0]);
    messageLen.writeUInt16BE(cmd.length,0);

    const prefix = Buffer.from([
      statics.MESSAGE_START,
      this.sequence,
      messageLen[0],
      messageLen[1],
      statics.TOKEN,
    ]);

    const message = Buffer.concat([prefix, cmd]);

    const checksum = Buffer.from([(new Array(message.length)).fill(0).reduce((a, b, i) => a ^ message[i], 0)]);
    const fullMessage = Buffer.concat([message, checksum]);
  
    try {
      await this.serial.write(fullMessage);
    } catch (err: any) {
      throw new Error(`Error writing "${cmd.toString('hex')}" to serial port: ${err.message}`);
    }
    if (opt.ignoreResponse) return Buffer.alloc(0);
    try {
      response = await this.receiveData(timeout, responseLength);
    } catch (err: any) {
      this.log(`Error receiving data after sending "${cmd.toString('hex')}"`);
      // this.log(err);
      throw err;
    }
    if (responseLength > 0 && !responseData.equals(response)) {
      throw new Error(`Response data mismatch: expected "${responseData.toString('hex')}" got "${response.toString('hex')}"`);
    }
    if (opt.checkOK) {
      let cmdSentName = 'Unknown CMD';
      let cmdRespName = 'Unknown CMD';
      let statusName = 'Unknown Status'
      Object.keys(statics).forEach((key) => {
        if (statics[key] === cmd[0]) cmdSentName = key;
        if (statics[key] === cmd[1]) statusName = key;
        if (statics[key] === response[0]) cmdRespName = key;
      });
      if (response[0] !== cmd[0]) {
        throw new Error(`command response was not ${cmdSentName} (0x${cmd[0].toString(16)}). Instead received ${cmdRespName} (0x${response[0].toString(16)})`);
      }
      if (response[1] !== statics.STATUS_CMD_OK) {
        throw new Error(`command did not return with OK status. Instead returned ${statusName} (0x${cmd[1]?.toString(16)})`);
      }
    }
    return response;
  }
  
  async sync(attempts = 3, timeout = 400, ogAttempts = attempts): Promise<string> {
    this.log(`sync ${attempts}`);
    try {
      const res = await this.sendCommand({
        cmd: [
          statics.CMD_SIGN_ON
        ],
        timeout,
        checkOK: true,
      });
      this.log(`sync complete after ${ogAttempts - attempts + 1} attempt: ${res.toString('hex')}`);
      const len = res[2];
      return res.subarray(3, 3 + len).toString();
    } catch (err) {
      if (attempts <= 1) {
        throw err;
      }
      return await this.sync(attempts - 1, timeout, ogAttempts);
    }
  }

  async reset(delay1: number, delay2: number) {
    this.log('reset');
    await setDTRRTS(this.serial, false);
    await asyncTimeout(delay1);

    await setDTRRTS(this.serial, true);
    await asyncTimeout(delay1);

    await setDTRRTS(this.serial, false);
    await asyncTimeout(delay2);

  }

  async getSignature(timeout = 400): Promise<Buffer> {
    const reportedSignature = Buffer.alloc(3);

    const getByte = async (index: number) => {
      const res = await this.sendCommand({
        cmd: [
          statics.CMD_SPI_MULTI,
          0x04, // numTx
          0x04, // numRx
          0x00, // rxStartAddr
          0x30,
          0x00,
          index,
          0x00,
        ],
        checkOK: true,
        timeout,
      });
      if (!res?.[5]) throw new Error(`Unexpected signature response: ${res?.toString('hex')}`);
      reportedSignature.writeUInt8(res[5], index);
    }

    await getByte(0x00);
    await getByte(0x01);
    await getByte(0x02);

    return reportedSignature;
  }

  async verifySignature(signature: Buffer, timeout = 400) {
    this.log('verify signature');

    const reportedSignature = await this.getSignature(timeout);
    if(!signature.equals(reportedSignature)){
      throw new Error(`signature doesn't match. Found: ${reportedSignature.toString('hex')}`);
    }
    return true;
  }

  async enterProgrammingMode(options?: ProgramOptions, timeout = 400) {
    this.log('send enter programming mode');

    await this.sendCommand({
      cmd: [
        statics.CMD_ENTER_PROGMODE_ISP,
        options?.timeout ?? defaultProgramOptions.timeout,
        options?.stabDelay ?? defaultProgramOptions.stabDelay,
        options?.cmdexeDelay ?? defaultProgramOptions.cmdexeDelay,
        options?.synchLoops ?? defaultProgramOptions.synchLoops,
        options?.byteDelay ?? defaultProgramOptions.byteDelay,
        options?.pollValue ?? defaultProgramOptions.pollValue,
        options?.pollIndex ?? defaultProgramOptions.pollIndex,
        0xac, // cmd1
        0x53, // cmd2
        0x00, // cmd3
        0x00, // cmd4
      ],
      checkOK: true,
      timeout,
    });
  }


  async loadAddress(useAddr: number, timeout = 400) {
    this.log('load address', useAddr);

    const msb = (useAddr >> 24) & 0xff | 0x80;
    const xsb = (useAddr >> 16) & 0xff;
    const ysb = (useAddr >> 8) & 0xff;
    const lsb = useAddr & 0xff;

    await this.sendCommand({
      cmd: [
        statics.CMD_LOAD_ADDRESS,
        msb,
        xsb,
        ysb,
        lsb,
      ],
      checkOK: true,
      timeout,
    });
  }

  async loadPage(writeBytes: Buffer, timeout = 400) {
    this.log('load page');

    const bytesMsb = writeBytes.length >> 8; //Total number of bytes to program, MSB first
    const bytesLsb = writeBytes.length & 0xff; //Total number of bytes to program, MSB first
    const mode = 0xc1; //paged, rdy/bsy polling, write page
    const delay = 0x0a; //Delay, used for different types of programming termination, according to mode byte
    const cmd1 = 0x40; // Load Page, Write Program Memory
    const cmd2 = 0x4c; // Write Program Memory Page
    const cmd3 = 0x20; //Read Program Memory
    const poll1 = 0x00; //Poll Value #1
    const poll2 = 0x00; //Poll Value #2 (not used for flash programming)


    let cmdBuf = Buffer.from([statics.CMD_PROGRAM_FLASH_ISP, bytesMsb, bytesLsb, mode, delay, cmd1, cmd2, cmd3, poll1, poll2]);

    cmdBuf = Buffer.concat([cmdBuf, writeBytes]);

    await this.sendCommand({
      cmd: cmdBuf,
      checkOK: true,
      timeout,
    });
  }

  async verifyPage(writeBytes: Buffer, timeout = 400) {
    this.log('load page');

    const bytesMsb = writeBytes.length >> 8; //Total number of bytes to program, MSB first
    const bytesLsb = writeBytes.length & 0xff; //Total number of bytes to program, MSB first

    await this.sendCommand({
      cmd: [
        statics.CMD_READ_FLASH_ISP,
        bytesMsb,
        bytesLsb,
        0x20, // Command 1 (there is little to no documentation on this)
      ],
      timeout,
      responseData: Buffer.concat([
        Buffer.from([statics.CMD_READ_FLASH_ISP, statics.STATUS_CMD_OK]),
        writeBytes,
        Buffer.from([statics.STATUS_CMD_OK]),
      ]),
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
      // await asyncTimeout(4);
    }, Promise.resolve());
    this.log('upload complete');
  }

  async exitProgrammingMode(timeout = 400) {
    this.log('send leave programming mode');

    const preDelay = 0x01;
    const postDelay = 0x01;

    await this.sendCommand({
      cmd: [statics.CMD_LEAVE_PROGMODE_ISP, preDelay, postDelay],
      checkOK: true,
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
      await this.verifyPage(writeBytes, timeout);
      this.log(`verified page ${i + 1} of ${pages.length}`);
      asyncTimeout(4);
    }, Promise.resolve());
    this.log('verification complete');
  }

  async bootload(hex: Buffer, opt: ProgramOptions) {
    this.log('bootload');
    opt.pageSize = opt.pageSize || 256;

    await this.reset(1, 1);
    await this.sync(5, opt.timeout);
    await this.verifySignature(opt.signature, opt.timeout);
    await this.enterProgrammingMode(opt, opt.timeout);
    await this.upload(hex, opt.pageSize, opt.timeout);
    await this.verify(hex, opt.pageSize, opt.timeout);
    await this.exitProgrammingMode(opt.timeout);

    this.log('bootload complete');
  }
};
