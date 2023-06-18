import { SerialPort } from 'serialport/dist/index.d';
import { SerialPortPromise } from '../../serialport/serialport-promise';
import { waitForOpen, setDTRRTS } from '../../util/serial-helpers';
import asyncTimeout from '../../util/async-timeout';
import { StdOut } from '../../index';

import { getDeviceName } from './device-lookup';

export interface ReconnectParams {
  baudRate: number;
}

interface AVR109Options {
  quiet?: boolean;
  speed?: number;
  signature?: string;
  testBlockMode?: boolean;
  deviceCode?: number;
  writeToEeprom?: boolean;
  stdout?: StdOut;
  avr109Reconnect: (opts: ReconnectParams) => Promise<SerialPort>;
}

interface ReceiveOptions {
  timeout?: number;
  responseLength?: number;
  readUntilNull?: boolean;
}

interface CommandOptions {
  cmd: Buffer | string | number;
  timeout?: number;
  len?: number;
  readUntilNull?: boolean;
}

interface BootloadOptions {
  signature: Buffer,
  pageSize?: number;
  maxWriteDelay?: number;
  chipEraseDelay?: number;
}

// AVR109 protocol
// https://ww1.microchip.com/downloads/en/Appnotes/doc1644.pdf
const statics = {
  CMD_ENTER_PROG_MODE: 'P'.charCodeAt(0),
  CMD_AUTO_INC_ADDR: 'a'.charCodeAt(0),
  CMD_SET_ADDR: 'A'.charCodeAt(0),
  CMD_WRITE_PROG_MEM_LOW: 'c'.charCodeAt(0),
  CMD_WRITE_PROG_MEM_HIGH: 'C'.charCodeAt(0),
  CMD_ISSUE_PAGE_WRITE: 'm'.charCodeAt(0),
  CMD_READ_LOCK_BITS: 'r'.charCodeAt(0),
  CMD_READ_PROG_MEM: 'R'.charCodeAt(0),
  CMD_READ_DATA_MEM: 'd'.charCodeAt(0),
  CMD_WRITE_DATA_MEM: 'D'.charCodeAt(0),
  CMD_CHIP_ERASE: 'e'.charCodeAt(0),
  CMD_WRITE_LOCK_BITS: 'l'.charCodeAt(0),
  CMD_READ_FUSE_BITS: 'F'.charCodeAt(0),
  CMD_READ_HIGH_FUSE_BITS: 'N'.charCodeAt(0),
  CMD_READ_EXT_FUSE_BITS: 'Q'.charCodeAt(0),
  CMD_LEAVE_PROG_MODE: 'L'.charCodeAt(0),
  CMD_SELECT_DEVICE_TYPE: 'T'.charCodeAt(0),
  CMD_READ_SIGNATURE_BYTES: 's'.charCodeAt(0),
  CMD_RETURN_DEVICE_CODES: 't'.charCodeAt(0),
  CMD_RETURN_SOFTWARE_ID: 'S'.charCodeAt(0),
  CMD_RETURN_SOFTWARE_VER: 'V'.charCodeAt(0),
  CMD_RETURN_HARDWARE_VER: 'v'.charCodeAt(0),
  CMD_RETURN_PROGRAMMER_TYPE: 'p'.charCodeAt(0),
  CMD_SET_LED: 'x'.charCodeAt(0),
  CMD_CLEAR_LED: 'y'.charCodeAt(0),
  CMD_EXIT_BOOTLOADER: 'E'.charCodeAt(0),
  CMD_CHECK_BLOCK_SUPPORT: 'b'.charCodeAt(0),
  CMD_START_BLOCK_LOAD: 'B'.charCodeAt(0),
  CMD_START_BLOCK_READ: 'g'.charCodeAt(0),

  RES_EMPTY: '\r'.charCodeAt(0),
  RES_UNKNOWN: '?'.charCodeAt(0),

  FLAG_FLASH: 'F'.charCodeAt(0),
  FLAG_EEPROM: 'E'.charCodeAt(0),
};

export default class AVR109 {
  opts: AVR109Options;
  quiet: boolean;
  signature: string;
  serial: SerialPortPromise;
  orgSerialPort: SerialPortPromise;
  orgSpeed: number;
  hasAutoIncrAddr: boolean;
  bufferSize: number;
  useBlockMode: boolean;
  deviceCode: number;

  constructor(serial: SerialPort | SerialPortPromise, opts: AVR109Options) {
    this.opts = opts || {};
    this.signature = this.opts.signature || 'LUFACDC';
    this.quiet = this.opts.quiet || false;
    this.serial = serial instanceof SerialPortPromise ? serial : new SerialPortPromise(serial);

    this.hasAutoIncrAddr = false;
    this.bufferSize = 0;
    this.useBlockMode = false;
    this.deviceCode = this.opts.deviceCode || 0;
    this.orgSerialPort = this.serial;
    this.orgSpeed = this.serial.baudRate || 115200;
  }

  log (...args: any[]) {
    if (this.quiet) return;
    this.opts.stdout?.write(`${args.join(' ')}\r\n`);
  }

  async send(data: Buffer | string | number) {
    let buf;
    if (typeof data === 'string') {
      buf = Buffer.from(data, 'ascii');
    } else if (typeof data === 'number') {
      buf = Buffer.from([data]);
    } else {
      buf = data;
    }
    
    await this.serial.write(buf);
  }

  recv(opts: ReceiveOptions): Promise<Buffer> {
    const {
      timeout = 1000,
      responseLength = 0,
      readUntilNull = false,
    } = opts;
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let timeoutId = null as NodeJS.Timeout | null;
      let handleChunk = (data: Buffer) => {};
      const finished = (err?: Error) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        this.serial.removeListener('data', handleChunk);
        if (err) {
          reject(err);
        } else {
          resolve(buffer);
        }
      };
      handleChunk = (data: Buffer) => {
        if (readUntilNull && data.indexOf(0x00) !== -1) {
          buffer = Buffer.concat([buffer, data.slice(0, data.indexOf(0x00))]);
          return finished();
        }
        buffer = Buffer.concat([buffer, data]);
        if (!readUntilNull) {
          if (buffer.length > responseLength) {
            return finished(new Error(`buffer overflow ${buffer.length} > ${responseLength}`));
          }
          if (buffer.length == responseLength) {
            finished();
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

  async cmd(opts: CommandOptions) {
    const { cmd, timeout = 100, len = 0, readUntilNull } = opts;
    const readPromise = this.recv({ 
      timeout,
      responseLength: len || 1,
      readUntilNull,
    });
    await this.send(cmd);
    const data = await readPromise;
    if (!len && !readUntilNull) {
      const byte = data[0];
      if (byte !== statics.RES_EMPTY && byte !== statics.RES_UNKNOWN) {
        throw new Error(`Command ${cmd} failed, expected \\r, got ${data.toString('hex')}`);
      }
    }
    return data;
  }

  async chipErase(timeout?: number) {
    await this.cmd({ cmd: statics.CMD_CHIP_ERASE, timeout: timeout || 9000 });
  }

  enterProgrammingMode() {
    return this.cmd({ cmd: statics.CMD_ENTER_PROG_MODE });
  }

  leaveProgrammingMode() {
    return this.cmd({ cmd: statics.CMD_LEAVE_PROG_MODE });
  }

  programEnable() {
    return null;
  }

  async init() {
    // Get the programmer identifier. Programmer returns exactly 7 chars _without_ the null.
    const id = await this.cmd({ cmd: statics.CMD_RETURN_SOFTWARE_ID, len: 7 });
    this.log(`Programmer ID: ${id.toString('ascii')}`);

    // Get the HW and SW versions to see if the programmer is present.
    const buffToVer = (buff: Buffer) => buff.toString('ascii').split('').join('.');

    const sw = await this.cmd({ cmd: statics.CMD_RETURN_SOFTWARE_VER, len: 2 });
    this.log(`Software Version: ${buffToVer(sw)}`);
    const hwTest = await this.cmd({ cmd: statics.CMD_RETURN_HARDWARE_VER, len: 1 });
    if (hwTest[0] === statics.RES_UNKNOWN) {
      this.log('No hardware version given');
    } else {
      const hw = await this.cmd({ cmd: statics.CMD_RETURN_HARDWARE_VER, len: 2 });
      this.log(`Hardware Version: ${buffToVer(hw)}`);
    }
      
    // Get the programmer type (serial or parallel). Expect serial.
    const type = await this.cmd({ cmd: statics.CMD_RETURN_PROGRAMMER_TYPE, len: 1 });
    this.log(`Programmer Type: ${type.toString('ascii')}`);


    // See if programmer supports auto-increment of address.
    const autoIncAdd = await this.cmd({ cmd: statics.CMD_AUTO_INC_ADDR, len: 1 });
    this.hasAutoIncrAddr = autoIncAdd.toString('ascii') === 'Y';
    if (this.hasAutoIncrAddr) {
      this.log('Programmer supports auto addr increment.');
    }

    // Check support for buffered memory access, ignore if not available
    if (this.opts.testBlockMode !== false) {
      const bufferSize = await this.cmd({ cmd: statics.CMD_CHECK_BLOCK_SUPPORT, len: 3 });
      this.useBlockMode = bufferSize.subarray(0, 1).toString('ascii') === 'Y';
      if (this.useBlockMode) {
        this.bufferSize = bufferSize.readUInt16BE(1);
        this.log(`Programmer supports buffered memory access with ${this.bufferSize} bytes buffer.`);
      }
    } else {
      this.useBlockMode = false;
    }

    // Get list of devices that the programmer supports.
    const devices = await this.cmd({ cmd: statics.CMD_RETURN_DEVICE_CODES, readUntilNull: true });
    if (devices.length) {
      this.log('Programmer supports the following devices:');
      for (let i = 0; i < devices.length; i += 1) {
        const device = devices[i];
        this.log(`  Device Code: 0x${device.toString(16)} (${getDeviceName(device)})`);
      }
      this.log('');
      if (this.opts.deviceCode && devices.indexOf(this.opts.deviceCode) === -1) {
        throw new Error(`Device code 0x${this.opts.deviceCode.toString(16)} not supported by programmer.`);
      } else if (!this.deviceCode) {
        this.deviceCode = devices[0];
      }
    } else {
      throw new Error('No devices supported by programmer.');
    }

    // Tell the programmer which part we selected.
    await this.cmd({ cmd: Buffer.from([statics.CMD_SELECT_DEVICE_TYPE, this.deviceCode]) });
    this.log(`Selected device: 0x${this.deviceCode.toString(16)} ${getDeviceName(this.deviceCode)}`);

    await this.enterProgrammingMode();
  }

  setAddr(addr: number) {
    const cmd = Buffer.alloc(3);
    cmd[0] = statics.CMD_SET_ADDR;
    cmd.writeUInt16BE(addr, 1);
    return this.cmd({ cmd });
  }

  async blockWrite(data: Buffer, addr: number) {
    const pageSize = this.opts.writeToEeprom ? 1 : (this.bufferSize || 128);
    const pageCount = Math.ceil(data.length / pageSize);
    const wrSize = this.opts.writeToEeprom ? 1 : 2;
    for (let i = 0; i < pageCount; i += 1) {
      const cursor = i * pageSize;
      if (!this.hasAutoIncrAddr || i === 0) {
        await this.setAddr((addr + cursor) / wrSize);
      }
      const page = data.slice(cursor, Math.min(cursor + pageSize, data.length));
      let cmd = Buffer.alloc(4);
      cmd[0] = statics.CMD_START_BLOCK_LOAD;
      cmd.writeUInt16BE(page.length, 1);
      cmd[3] = this.opts.writeToEeprom ? statics.FLAG_EEPROM : statics.FLAG_FLASH;
      cmd = Buffer.concat([cmd, page]);
  
      await this.cmd({ cmd });
    }
  }

  async blockRead(addr: number, len: number) {
    const pageSize = this.opts.writeToEeprom ? 1 : (this.bufferSize || 128);
    const pageCount = Math.ceil(len / pageSize);
    const wrSize = this.opts.writeToEeprom ? 1 : 2;
    const data = Buffer.alloc(len);
    for (let i = 0; i < pageCount; i += 1) {
      const cursor = i * pageSize;
      if (!this.hasAutoIncrAddr || i === 0) {
        await this.setAddr((addr + cursor) / wrSize);
      }
      const readSize = Math.min(pageSize, len - cursor);
      let cmd = Buffer.alloc(4);
      cmd[0] = statics.CMD_START_BLOCK_READ;
      cmd.writeUInt16BE(readSize, 1);
      cmd[3] = this.opts.writeToEeprom ? statics.FLAG_EEPROM : statics.FLAG_FLASH;
      const page = await this.cmd({ cmd, len: readSize });
      page.copy(data, cursor);
    }
    return data;
  }

  async pagedWriteFlash(data: Buffer, address: number, pageSize: number, timeout?: number) {
    const cmds = [statics.CMD_WRITE_PROG_MEM_LOW, statics.CMD_WRITE_PROG_MEM_HIGH];
    const buf = Buffer.alloc(2);
    const maxAddr = address + data.length;
    let addr = address;
    let pageAddr;
    let pageBytes = pageSize;
    let pageWrCmdPending = false;

    pageAddr = addr;
    await this.setAddr(pageAddr);

    while(addr < maxAddr) {
      pageWrCmdPending = true;
      buf[0] = cmds[addr & 0x01];
      buf[1] = data[addr];
      await this.cmd({ cmd: buf });

      addr += 1;
      pageBytes -= 1;

      if (pageBytes === 0) {
        await this.setAddr(pageAddr >> 1);
        await this.cmd({ cmd: statics.CMD_ISSUE_PAGE_WRITE, timeout: timeout || 4500 });

        pageWrCmdPending = false;
        await this.setAddr(addr >> 1);
        pageAddr = addr;
        pageBytes = pageSize;
      } else if (!this.hasAutoIncrAddr && (addr & 0x01) === 0) {
        await this.setAddr(addr >> 1);
      }
    }

    if (pageWrCmdPending) {
      await this.setAddr(pageAddr >> 1);
      await this.cmd({ cmd: statics.CMD_ISSUE_PAGE_WRITE, timeout: timeout || 4500 });
    }
  }

  async pagedWriteEeprom(data: Buffer, address: number, timeout?: number) {
    const buff = Buffer.alloc(2);
    const maxAddr = address + data.length;
    let addr = address;

    await this.setAddr(addr);

    buff[0] = statics.CMD_WRITE_DATA_MEM;

    while(addr < maxAddr) {
      buff[1] = data[addr];
      await this.cmd({ cmd: buff, timeout: timeout || 4500 });

      addr += 1;
      if (!this.hasAutoIncrAddr) {
        await this.setAddr(addr);
      }
    }
  }

  async pagedReadBytes(address: number, len: number) {
    const data = Buffer.alloc(len);
    const cmd = this.opts.writeToEeprom
      ? statics.CMD_READ_DATA_MEM 
      : statics.CMD_READ_PROG_MEM;
    const rdSize = this.opts.writeToEeprom ? 1 : 2;
    const maxAddr = address + len;
    let addr = address;
    await this.setAddr(addr);
    while (addr < maxAddr) {
      const buff = await this.cmd({ cmd, len: 1 });
      if (rdSize === 2) {
        data[addr] = buff[1];
        data[addr + 1] = buff[0];
      } else {
        data[addr] = buff[0];
      }
      addr += rdSize;
      if (!this.hasAutoIncrAddr) {
        await this.setAddr(addr / rdSize);
      }
    }
    return data;
  }

  async pagedWrite(data: Buffer, address: number, pageSize: number, timeout?: number) {
    if (!this.useBlockMode) {
      if (this.opts.writeToEeprom) {
        await this.pagedWriteEeprom(data, address, timeout);
      } else {
        await this.pagedWriteFlash(data, address, pageSize, timeout);
      }
    } else {
      await this.blockWrite(data, address);
    }
  }

  async pagedRead(address: number, len: number) {
    if (!this.useBlockMode) {
      return this.pagedReadBytes(address, len);
    }
    return this.blockRead(address, len);
  }

  async program(data: Buffer, address: number, pageSize: number, timeout?: number) {
    await this.pagedWrite(data, address, pageSize, timeout);
  }

  async verify(data: Buffer, address: number) {
    const rdData = await this.pagedRead(address, data.length);
    return rdData.equals(data);
  }

  reconnect(opts: ReconnectParams): Promise<SerialPortPromise> {
    return new Promise((resolve, reject) => {
      let timedOut = false;
      let timeoutId: NodeJS.Timeout;
      timeoutId = setTimeout(() => {
        timedOut = true;
        this.log('reconnect timed out');
        reject(new Error('reconnect timed out'));
      }, 30 * 1000);
      this.opts.avr109Reconnect(opts)
        .then((serial: SerialPort | SerialPortPromise) => {
          clearTimeout(timeoutId);
          if (timedOut) return;
          resolve(serial instanceof SerialPortPromise ? serial : new SerialPortPromise(serial));
        })
        .catch(reject);
    });
  }

  async enterBootloader() {
    if (!this.serial.isOpen) {
      await this.serial.open();
      await waitForOpen(this.serial);
    }
    await this.serial.update({ baudRate: 1200 });
    await asyncTimeout(500);
    // await setDTRRTS(this.serial, false);
    // await asyncTimeout(20);
    // await setDTRRTS(this.serial, true);
    // await asyncTimeout(20);
    // await setDTRRTS(this.serial, false);
    // await asyncTimeout(20);
    // await setDTRRTS(this.serial, true);
    // await this.serial.close();
    // await this.serial.open();
    const ts = Date.now();
    await this.serial.close();
    await asyncTimeout(500);
    this.serial = await this.reconnect({ baudRate: this.opts.speed || 57600 });
    if (!this.serial.isOpen) {
      await this.serial.open();
      await waitForOpen(this.serial);
    }
    console.log(this.serial?.port);
    if (this.serial.baudRate !== this.opts.speed) {
      await this.serial.update({ baudRate: this.opts.speed || 57600 });
    }
    await asyncTimeout(200);
    console.log('reconnected', Date.now() - ts);
  }

  async exitBootloader() {
    await this.cmd({ cmd: statics.CMD_EXIT_BOOTLOADER });
    await this.serial.close();
  }

  async sync(count = 0): Promise<void> {
    try {
      await this.cmd({ cmd: statics.CMD_RETURN_SOFTWARE_ID, len: 7 });
    } catch (err: any) {
      if (!err.message?.includes('receiveData timeout after')) throw err;
      if (count > 5) throw new Error('Failed to connect to bootloader');
      console.error(err);
      return this.sync(count + 1);
    }
  }

  async bootload(data: Buffer, opt: BootloadOptions) {
    this.log('Entering bootloader');
    await this.enterBootloader();
    this.log('Synchronising');
    await this.sync();
    this.log('Initialising');
    await this.init();
    this.log('Erasing Chip');
    await this.chipErase(opt.chipEraseDelay);
    this.log('Programming');
    await this.program(data, 0, opt.pageSize || 128, opt.maxWriteDelay);
    this.log('Verifying');
    const isVerified = await this.verify(data, 0);
    if (!isVerified) {
      throw new Error('Verification failed');
    } else {
      this.log('Verification successful');
    }
    this.log('Resetting');
    await this.leaveProgrammingMode();
    await this.exitBootloader();
    this.log('Reconnecting');
    await asyncTimeout(2 * 1000);
    if (typeof window === 'undefined') {
      this.serial = this.orgSerialPort;
      await this.serial.open();
      await waitForOpen(this.serial, 1000);
      await this.serial.update({ baudRate: this.orgSpeed });
    } else {
      this.serial = await this.reconnect({ baudRate: this.orgSpeed });
      await this.serial.open();
      await waitForOpen(this.serial, 1000);
    }
    return this.serial;
  }

}
