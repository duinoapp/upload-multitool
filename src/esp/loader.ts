import { SerialPort } from 'serialport/dist/index.d';
import pako from 'pako';
import MD5 from 'crypto-js/md5';
import encBase64 from 'crypto-js/enc-base64';
import { SerialPortPromise } from '../serialport/serialport-promise';
import { castToSPP } from '../util/serial-helpers';
import StubLoader from './stub-loader';
import roms from './roms/index';
import ROM from './roms/rom.d';
import { StdOut } from '../index';

export interface ESPOptions {
  quiet?: boolean;
  stubUrl?: string;
  stdout?: StdOut;
}

export interface UploadFileDef {
  data: Buffer;
  address: number;
}

export default class ESPLoader {
  ESP_RAM_BLOCK = 0x1800;

  ESP_FLASH_BEGIN = 0x02;

  ESP_FLASH_DATA = 0x03;

  ESP_FLASH_END = 0x04;
  
  ESP_MEM_BEGIN = 0x05;
  
  ESP_MEM_END = 0x06;
  
  ESP_MEM_DATA = 0x07;

  ESP_SYNC = 0x08;
  
  ESP_WRITE_REG = 0x09;

  ESP_FLASH_DEFL_BEGIN = 0x10;

  ESP_FLASH_DEFL_DATA = 0x11;

  ESP_FLASH_DEFL_END = 0x12;

  ESP_SPI_FLASH_MD5 = 0x13;

  ESP_READ_REG = 0x0A;

  ESP_SPI_ATTACH = 0x0D;

  // Only Stub supported commands
  ESP_CHANGE_BAUDRATE = 0x0F;

  ESP_ERASE_FLASH = 0xD0;

  ESP_ERASE_REGION = 0xD1;

  ESP_IMAGE_MAGIC = 0xe9;

  ESP_CHECKSUM_MAGIC = 0xef;

  ERASE_REGION_TIMEOUT_PER_MB = 30000;

  ERASE_WRITE_TIMEOUT_PER_MB = 40000;

  MD5_TIMEOUT_PER_MB = 8000;

  CHIP_ERASE_TIMEOUT = 120000;

  MAX_TIMEOUT = this.CHIP_ERASE_TIMEOUT * 2;

  CHIP_DETECT_MAGIC_REG_ADDR = 0x40001000;

  DETECTED_FLASH_SIZES = {
    0x12: '256KB', 0x13: '512KB', 0x14: '1MB', 0x15: '2MB', 0x16: '4MB', 0x17: '8MB', 0x18: '16MB',
  } as { [key: number]: string };

  opts: ESPOptions;
  quiet: boolean;
  serial: SerialPortPromise;
  IS_STUB: boolean;
  chip: ROM | null;
  stdout: any;
  stubLoader: StubLoader;
  syncStubDetected: boolean;
  FLASH_WRITE_SIZE: number;

  constructor(serial: SerialPort | SerialPortPromise, opts = {} as ESPOptions) {
    this.opts = opts || {};
    this.quiet = this.opts.quiet || false;
    this.serial = castToSPP(serial);
    this.IS_STUB = false;
    this.chip = null;
    this.stdout = opts.stdout || process?.stdout || {
      write: (str: string) => console.log(str.replace(/(\n|\r)+$/g, '')),
    };
    this.stubLoader = new StubLoader(this.opts.stubUrl);
    this.syncStubDetected = false;
    this.FLASH_WRITE_SIZE = 0x4000
  }

  // pause execution for x ms
  #sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // log out a line of text
  log (...args: any[]) {
    if (this.quiet) return;
    this.stdout.write(`${args.map(arg => `${arg}`).join(' ')}\r\n`);
  }

  // log out a set of characters
  logChar(str: string) {
    if (this.quiet) return;
    if (this.stdout) {
      this.stdout.write(str);
    } else {
      // eslint-disable-next-line no-console
      console.log(str);
    }
  }

  // convert a number into a Uint8Array of 2 bytes, little endian
  #shortToByteArray(i: number): Uint8Array {
    const buff = Buffer.alloc(2);
    buff.writeUInt16LE(i, 0);
    return new Uint8Array(buff);
  }

  // convert a number into a Uint8Array of 4 bytes, little endian
  #intToByteArray(i: number) {
    const buff = Buffer.alloc(4);
    buff.writeUInt32LE(i, 0);
    return new Uint8Array(buff);
  }

  // convert an array of 2 bytes into a number, little endian
  #byteArrayToShort(arr: [number, number] | Buffer) {
    const buff = Buffer.alloc(2);
    buff.set(arr, 0);
    return buff.readUInt16LE(0);
  }

  // convert an array of 4 bytes into a number, little endian
  #byteArrayToInt(arr: [number, number, number, number] | Buffer) {
    const buff = Buffer.alloc(4);
    buff.set(arr, 0);
    return buff.readUInt32LE(0);
  }

  // join Uint8Arrays or Buffers together
  #appendArray(...arrays: Buffer[] | Uint8Array[]) {
    const arrayLengths = arrays.map((arr) => arr.length);
    const totalLength = arrayLengths.reduce((a, b) => a + b, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    arrays.forEach((arr) => {
      result.set(arr, offset);
      offset += arr.length;
    });
    return result;
  }

  // flush the serial port
  #flushInput = async () => {
    try {
      await this.serial.flush();
    } catch (e) {}
  }

  // convert data before sending to the device https://en.wikipedia.org/wiki/Serial_Line_Internet_Protocol
  async write(data: Buffer) {
    const slippedArr = [];
    for (let i = 0; i < data.length; i++) {
      const byte = data[i];
      if (byte === 0xC0) slippedArr.push(0xDB, 0xDC); // escape the end char
      else if (byte === 0xDB) slippedArr.push(0xDB, 0xDD); // escape the escape char
      else slippedArr.push(byte);
    }
    const pkt = Buffer.from([0xC0, ...slippedArr, 0xC0]);
    return this.serial.write(pkt);
  }

  // read data from the device, un-slipping it
  read(timeout = 0, flush = false): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      // initialise some variables
      let buffer = Buffer.alloc(0);
      let started = false;
      let timeoutId = null as NodeJS.Timeout | null;
      let handleChunk = (data: Buffer) => {};
      // finish handler that cleans up the listeners and resolves the promise
      const finished = (err?: Error) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        this.serial.removeListener('data', handleChunk);
        if (err) {
          if (flush && buffer.length) {
            resolve(buffer);
          } else {
            reject(err);
          }
        } else {
          resolve(buffer);
        }
      };
      // handle a chunk of data
      handleChunk = (data: Buffer) => {
        if (flush) { // don't bother parsing the data, just return it
          Buffer.concat([buffer, data]);
          return;
        }
        // loop through each byte, looking for the start and end of the packet
        // and un-escaping any escaped characters in the middle
        const pkt = [] as number[];
        let inEscape = false;
        for (let i = 0; i < data.length; i++) {
          const byte = data[i];
          if (started) {
            if (byte === 0xC0) {
              started = false;
              break;
            } else if (byte === 0xDC && inEscape) {
              pkt.push(0xC0);
              inEscape = false;
            } else if (byte === 0xDD && inEscape) {
              pkt.push(0xDB);
              inEscape = false;
            } else if (byte === 0xDB) {
              inEscape = true;
            } else {
              pkt.push(byte);
              inEscape = false;
            }
          } else if (byte === 0xC0) {
            started = true;
          }
        }
        if (pkt.length) {
          buffer = Buffer.concat([buffer, Buffer.from(pkt)]);
        }
        // if the packet is complete, call the finished handler
        if (buffer.length && !started) {
          finished();
        }
      };
      // set up the timeout handler
      if (timeout && timeout > 0) {
        timeoutId = setTimeout(() => {
          timeoutId = null;
          finished(new Error(`receiveData timeout after ${timeout}ms`));
        }, timeout);
      }
      // register the chunk handler
      this.serial.on('data', handleChunk);
    });
  }

  // send a command to the device and optionally wait for a response
  // https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html#command-packet
  async command({
    op = null as number | null,
    data = [] as number[] | Uint8Array | Buffer,
    chk = 0, // checksum
    waitResponse = true,
    timeout = 3000,
    // min_data = 12,
  } = {}): Promise<[number, Buffer]> {
    // console.log('command ', op, waitResponse, timeout);
    if (op) {
      const pkt = Buffer.from([
        0x00,
        op,
        ...this.#shortToByteArray(data.length), // 2-3
        ...this.#intToByteArray(chk), // 4-7
        ...data, // 8+
      ]);
      await this.write(pkt);
    }

    // https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html#response-packet
    if (waitResponse) {
      const packet = await this.read(timeout, false);
      // const direction = packet[0]; // always 0x01
      const command = packet[1];
      const resDataSize = this.#byteArrayToShort(packet.subarray(2, 4));
      // value is the data returned from readReg commands, otherwise it's 0x00
      const value = this.#byteArrayToInt(packet.subarray(4, 8));
      const resData = packet.subarray(8, 8 + resDataSize);
      if (!op || command === op) {
        return [value, resData];
      }
      throw new Error(`Invalid response. Expected ${op.toString(16)}, got ${command.toString(16)}`);
    }
    return [0x00, Buffer.from([])];
  }

  // read from the device's memory at a given address
  async readReg(addr: number, timeout = 3000) {
    // console.log(`read reg ${addr} ${timeout}`);
    const pkt = this.#intToByteArray(addr);
    const val = await this.command({ op: this.ESP_READ_REG, data: pkt, timeout });
    // console.log('Read reg resp', val);
    return val[0];
  }

  // write to the device's memory at a given address
  async writeReg(addr: number, value: number, mask = 0xFFFFFFFF, delayUs = 0, delayAfterUs = 0) {
    if (!this.chip) throw new Error('Chip not initialized');
    let pkt = this.#appendArray(
      this.#intToByteArray(addr),
      this.#intToByteArray(value),
      this.#intToByteArray(mask),
      this.#intToByteArray(delayUs),
    );

    if (delayAfterUs > 0) {
      pkt = this.#appendArray(
        pkt,
        this.#intToByteArray(this.chip.UART_DATE_REG_ADDR),
        this.#intToByteArray(0),
        this.#intToByteArray(0),
        this.#intToByteArray(delayAfterUs),
      );
    }

    await this.checkCommand({
      opDescription: 'write target memory',
      op: this.ESP_WRITE_REG,
      data: pkt,
    });
  }

  // try to initialise synchronisation with the device
  // https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html#initial-synchronisation
  async sync() {
    const cmd = Buffer.alloc(36, 0x55);
    cmd.set([0x07, 0x07, 0x12, 0x20], 0);

    const resp = await this.command({ op: this.ESP_SYNC, data: cmd, timeout: 100 });
    this.syncStubDetected = resp[0] === 0;
    return resp;
  }

  // attempt to establish a synced connection with the device
  async #connectAttempt({ mode = 'default_reset', esp32r0Delay = false } = {}) {
    // console.log(`_connect_attempt ${esp32r0Delay}`);
    if (mode !== 'no_reset') {
      // reset the device before syncing
      await this.serial.set({ dtr: false, rts: false });
      await this.#sleep(50);
      await this.serial.set({ dtr: true, rts: true });
      await this.serial.set({ dtr: false, rts: true });
      await this.#sleep(100);
      if (esp32r0Delay) {
        // await this._sleep(1200);
        await this.#sleep(2000);
      }
      await this.serial.set({ dtr: true, rts: false });
      if (esp32r0Delay) {
        // await this._sleep(400);
        // await this.#sleep(400);
      }
      await this.#sleep(50);
      await this.serial.set({ dtr: false, rts: false });
      await this.serial.set({ dtr: false, rts: false });
    }
    // wait until the device is finished booting (writing initial data to serial)
    // eslint-disable-next-line no-constant-condition
    while (1) {
      try {
        await this.read(500, true);
      } catch (err) {
        // if nothing was read, the device is ready
        if (err instanceof Error && err.message.includes('timeout')) {
          break;
        }
      }
      await this.#sleep(50);
    }
    // try to sync with the device 8 times
    for (let i = 0; i < 8; i++) {
      try {
        await this.sync();
        return 'success';
      } catch (err) {
        if (err instanceof Error && err.message.includes('timeout')) {
          this.logChar(esp32r0Delay ? '_' : '.');
        } else {
          throw err;
        }
      }
      await this.#sleep(50);
    }
    return 'error';
  }

  // establish a synced connection with the device
  // eslint-disable-next-line no-unused-vars
  async connect({ mode = 'default_reset', attempts = 7, detecting = false } = {}) {
    let resp = '';
    this.logChar('Connecting...');
    // try several times to connect, toggling between delay options
    for (let i = 0; i < attempts * 2; i++) {
      resp = await this.#connectAttempt({ mode, esp32r0Delay: i % 2 === 0 });
      if (resp === 'success') break;
    }
    this.logChar('\n');
    this.logChar('\r');
    if (resp !== 'success') {
      this.log('Failed to connect with the device');
      return 'error';
    }
    await this.#sleep(100);
    await this.#flushInput();

    // try to detect the chip we're dealing with
    if (!detecting) {
      const chipMagicValue = await this.readReg(0x40001000);
      // eslint-disable-next-line no-console
      // console.log(`Chip Magic ${chip_magic_value}`);
      this.chip = roms.find((cls) => chipMagicValue === cls.CHIP_DETECT_MAGIC_VALUE) ?? null;
      // console.log('chip', this.chip);
    }
    return null;
  }

  // connect to the device and detect the chip
  async detectChip() {
    await this.connect();
    this.logChar('Detecting chip type... ');
    if (this.chip !== null) {
      this.log(this.chip.CHIP_NAME);
    }
  }

  // run a command and check the response, sort the readReg values from the data
  async checkCommand({
    // eslint-disable-next-line no-unused-vars
    opDescription = '', // useful for debugging
    op = null as number | null,
    data = [] as number[] | Uint8Array | Buffer,
    chk = 0,
    timeout = 3000,
    /* min_data, */
  } = {}) {
    // console.log(`checkCommand ${op}`);
    const resp = await this.command({
      op, data, chk, timeout, /* min_data, */
    });
    if (resp[1].length > 4) {
      return resp[1];
    }
    return resp[0];
  }

  // create a checksum number for a set of data by XORing all the bytes
  #checksum(data: number[] | Uint8Array | Buffer) {
    let chk = 0xEF;
    for (let i = 0; i < data.length; i++) {
      chk ^= data[i];
    }
    return chk;
  }

  // initialise a write to the device's memory with config data
  // https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html#writing-data
  async memBegin(size: number, blocks: number, blocksize: number, offset: number) {
    /* XXX: Add check to ensure that STUB is not getting overwritten */
    // console.log(`memBegin ${size} ${blocks} ${blocksize} ${offset}`);
    const pkt = this.#appendArray(
      this.#intToByteArray(size),
      this.#intToByteArray(blocks),
      this.#intToByteArray(blocksize),
      this.#intToByteArray(offset),
    );
    await this.checkCommand({
      opDescription: 'begin write to target RAM',
      op: this.ESP_MEM_BEGIN,
      data: pkt,
    });
  }

  // write a block of data to the device's memory
  // https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html#writing-data
  async memBlock(buffer: Uint8Array, seq: number) {
    let pkt = this.#appendArray(
      this.#intToByteArray(buffer.length),
      this.#intToByteArray(seq),
      this.#intToByteArray(0),
      this.#intToByteArray(0),
      buffer,
    );
    const checksum = this.#checksum(buffer);
    return this.checkCommand({
      opDescription: 'write to target RAM',
      op: this.ESP_MEM_DATA,
      data: pkt,
      chk: checksum,
    });
  }

  // finish writing to the device's memory, and run the code at the specified address
  // https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html#writing-data
  async memFinish(entrypoint: number) {
    const is_entry = (entrypoint === 0) ? 1 : 0;
    const pkt = this.#appendArray(this.#intToByteArray(is_entry), this.#intToByteArray(entrypoint));
    return this.checkCommand({
      opDescription: 'leave RAM upload mode',
      op: this.ESP_MEM_END,
      data: pkt,
      timeout: 500,
    }); // XXX: handle non-stub with diff timeout
  }

  // configure SPI flash pins
  async flashSpiAttach(hspiArg: number) {
    const pkt = this.#intToByteArray(hspiArg);
    await this.checkCommand({
      opDescription: 'configure SPI flash pins',
      op: this.ESP_SPI_ATTACH,
      data: pkt,
    });
  }

  // calculate the timeout required for a large data transfer
  #timeoutPerMb(secondsPerMb: number, sizeBytes: number) {
    const result = secondsPerMb * (sizeBytes / 1000000);
    return Math.min(result, 3000);
  }

  // initialise a write to the device's SPI Flash with config data
  // https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html#writing-data
  async flashBegin(size: number, offset: number) {
    if (!this.chip) throw new Error('chip not initialized');
    const numBlocks = Math.floor((size + this.FLASH_WRITE_SIZE - 1) / this.FLASH_WRITE_SIZE);
    const eraseSize = this.chip.getEraseSize(offset, size);
    const t1 = Date.now();

    let timeout = 3000;
    if (this.IS_STUB === false) {
      timeout = this.#timeoutPerMb(this.ERASE_REGION_TIMEOUT_PER_MB, size);
    }

    // eslint-disable-next-line no-console
    // console.log(`flash begin ${eraseSize} ${numBlocks} ${this.FLASH_WRITE_SIZE} ${offset} ${size}`);
    let pkt = this.#appendArray(
      this.#intToByteArray(eraseSize),
      this.#intToByteArray(numBlocks),
      this.#intToByteArray(this.FLASH_WRITE_SIZE),
      this.#intToByteArray(offset),
    );
    if (this.chip.SUPPORTS_ENCRYPTION && !this.IS_STUB) {
      // set encryption flag to false, ROM bootloader only, and on specific chips
      // XXX: Support encrypted
      pkt = this.#appendArray(pkt, this.#intToByteArray(0)); // XXX: Support encrypted
    }

    await this.checkCommand({
      opDescription: 'enter Flash download mode',
      op: this.ESP_FLASH_BEGIN,
      data: pkt,
      timeout,
    });

    const t2 = Date.now();
    if (size !== 0 && this.IS_STUB === false) {
      // ROM bootloader will also erase the flash region
      this.log(`Took ${(t2 - t1)}ms to erase flash block`);
    }
    return numBlocks;
  }

  // initialise a write of compressed data to the device's SPI Flash with config data
  // https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html#writing-data
  async flashDeflBegin(size: number, compSize: number, offset: number) {
    if (!this.chip) throw new Error('chip not initialized');
    const numBlocks = Math.floor((compSize + this.FLASH_WRITE_SIZE - 1) / this.FLASH_WRITE_SIZE);
    const eraseBlocks = Math.floor((size + this.FLASH_WRITE_SIZE - 1) / this.FLASH_WRITE_SIZE);
    const t1 = Date.now();

    let writeSize = size;
    let timeout = 3000;
    if (!this.IS_STUB) {
      // ROM bootloader will also erase the flash region, rounded up to erase block size
      writeSize = eraseBlocks * this.FLASH_WRITE_SIZE;
      timeout = this.#timeoutPerMb(this.ERASE_REGION_TIMEOUT_PER_MB, writeSize);
    }
    this.log(`Compressed ${size} bytes to ${compSize}...`);

    let pkt = this.#appendArray(
      this.#intToByteArray(writeSize),
      this.#intToByteArray(numBlocks),
      this.#intToByteArray(this.FLASH_WRITE_SIZE),
      this.#intToByteArray(offset),
    );

    if (this.chip.SUPPORTS_ENCRYPTION && !this.IS_STUB) {
      // set encryption flag to false, ROM bootloader only, and on specific chips
      // XXX: Support encrypted
      pkt = this.#appendArray(pkt, this.#intToByteArray(0));
    }
    if (this.chip.CHIP_NAME === 'ESP8266') {
      await this.#flushInput();
    }
    await this.checkCommand({
      opDescription: 'enter compressed flash mode',
      op: this.ESP_FLASH_DEFL_BEGIN,
      data: pkt,
      timeout,
    });
    const t2 = Date.now();
    if (size !== 0 && !this.IS_STUB) {
      // ROM bootloader will also erase the flash region
      this.log(`Took ${(t2 - t1)}ms to erase flash block`);
    }
    return numBlocks;
  }

  // write a raw block of data to the device's SPI Flash
  // https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html#writing-data
  async flashBlock(data: Uint8Array, seq: number, timeout: number) {
    let pkt = this.#appendArray(
      this.#intToByteArray(data.length),
      this.#intToByteArray(seq),
      this.#intToByteArray(0),
      this.#intToByteArray(0),
      data,
    );
    const checksum = this.#checksum(data);

    await this.checkCommand({
      opDescription: `write to target Flash after seq ${seq}`,
      op: this.ESP_FLASH_DATA,
      data: pkt,
      chk: checksum,
      timeout,
    });
  }

  // write a compressed block of data to the device's SPI Flash
  // https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html#writing-data
  async flashDeflBlock(data: Uint8Array, seq: number, timeout: number) {
    let pkt = this.#appendArray(
      this.#intToByteArray(data.length),
      this.#intToByteArray(seq),
      this.#intToByteArray(0),
      this.#intToByteArray(0),
      data,
    );
    const checksum = this.#checksum(data);

    await this.checkCommand({
      opDescription: `write compressed data to flash after seq ${seq}`,
      op: this.ESP_FLASH_DEFL_DATA,
      data: pkt,
      chk: checksum,
      timeout,
    });
  }

  // finish writing to the device's SPI Flash, and optionally reboot the device
  // https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html#writing-data
  async flashFinish({ reboot = false } = {}) {
    const val = reboot ? 0 : 1;
    const pkt = this.#intToByteArray(val);

    await this.checkCommand({
      opDescription: 'leave Flash mode',
      op: this.ESP_FLASH_END,
      data: pkt,
    });
  }

  // finish writing compressed data to the device's SPI Flash, and optionally reboot the device
  // https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html#writing-data
  async flashDeflFinish({ reboot = false } = {}) {
    const val = reboot ? 0 : 1;
    const pkt = this.#intToByteArray(val);

    await this.checkCommand({
      opDescription: 'leave compressed flash mode',
      op: this.ESP_FLASH_DEFL_END,
      data: pkt,
    });
  }

  // Run an arbitrary SPI flash command.

  // This function uses the "USR_COMMAND" functionality in the ESP
  // SPI hardware, rather than the precanned commands supported by
  // hardware. So the value of spiFlashCommand is an actual command
  // byte, sent over the wire.

  // After writing command byte, writes 'data' to MOSI and then
  // reads back 'readBits' of reply on MISO. Result is a number.
  async runSpiFlashCommand(spiFlashCommand: number, data: Uint8Array, readBits: number) {
    if (!this.chip?.SPI_REG_BASE) throw new Error('chip not initialized');
    // SPI_USR register flags
    const SPI_USR_COMMAND = (1 << 31);
    const SPI_USR_MISO = (1 << 28);
    const SPI_USR_MOSI = (1 << 27);

    // SPI registers, base address differs ESP32* vs 8266
    const base = this.chip.SPI_REG_BASE;
    const SPI_CMD_REG = base + 0x00;
    const SPI_USR_REG = base + this.chip.SPI_USR_OFFS;
    const SPI_USR1_REG = base + this.chip.SPI_USR1_OFFS;
    const SPI_USR2_REG = base + this.chip.SPI_USR2_OFFS;
    const SPI_W0_REG = base + this.chip.SPI_W0_OFFS;

    let setDataLengths;
    // following two registers are ESP32 and later chips only
    if (this.chip.SPI_MOSI_DLEN_OFFS !== null) {
      // ESP32 and later chips have a more sophisticated way
      // to set up "user" commands
      setDataLengths = async (mosiBits: number, misoBits: number) => {
        const SPI_MOSI_DLEN_REG = base + (this.chip?.SPI_MOSI_DLEN_OFFS || 0);
        const SPI_MISO_DLEN_REG = base + (this.chip?.SPI_MISO_DLEN_OFFS || 0);
        if (mosiBits > 0) {
          await this.writeReg(SPI_MOSI_DLEN_REG, mosiBits - 1);
        }
        if (misoBits > 0) {
          await this.writeReg(SPI_MISO_DLEN_REG, misoBits - 1);
        }
      };
    } else {
      setDataLengths = async (mosiBits: number, misoBits: number) => {
        const SPI_DATA_LEN_REG = SPI_USR1_REG;
        const SPI_MOSI_BIT_LEN_S = 17;
        const SPI_MISO_BIT_LEN_S = 8;
        const mosi_mask = (mosiBits === 0) ? 0 : (mosiBits - 1);
        const miso_mask = (misoBits === 0) ? 0 : (misoBits - 1);
        const val = (miso_mask << SPI_MISO_BIT_LEN_S) | (mosi_mask << SPI_MOSI_BIT_LEN_S);
        await this.writeReg(SPI_DATA_LEN_REG, val);
      };
    }

    // SPI peripheral "command" bitmasks for SPI_CMD_REG
    const SPI_CMD_USR = (1 << 18);
    // shift values
    const SPI_USR2_COMMAND_LEN_SHIFT = 28;
    if (readBits > 32) {
      throw new Error('Reading more than 32 bits back from a SPI flash operation is unsupported');
    }
    if (data.length > 64) {
      throw new Error('Writing more than 64 bytes of data with one SPI command is unsupported');
    }

    const dataBits = data.length * 8;
    const oldSpiUsr = await this.readReg(SPI_USR_REG);
    const oldSpiUsr2 = await this.readReg(SPI_USR2_REG);
    let flags = SPI_USR_COMMAND;
    let i;
    if (readBits > 0) {
      flags |= SPI_USR_MISO;
    }
    if (dataBits > 0) {
      flags |= SPI_USR_MOSI;
    }
    await setDataLengths(dataBits, readBits);
    await this.writeReg(SPI_USR_REG, flags);
    let val = (7 << SPI_USR2_COMMAND_LEN_SHIFT) | spiFlashCommand;
    await this.writeReg(SPI_USR2_REG, val);
    if (dataBits === 0) {
      await this.writeReg(SPI_W0_REG, 0); // clear data register before we read it
    } else {
      if (data.length % 4 !== 0) {
        // pad to 32-bit multiple
        const padding = new Uint8Array(data.length % 4);
        // eslint-disable-next-line no-param-reassign
        data = this.#appendArray(data, padding);
      }
      let nextReg = SPI_W0_REG;
      for (i = 0; i < data.length - 4; i += 4) {
        val = this.#byteArrayToInt([data[i], data[i + 1], data[i + 2], data[i + 3]]);
        await this.writeReg(nextReg, val);
        nextReg += 4;
      }
    }
    await this.writeReg(SPI_CMD_REG, SPI_CMD_USR);
    for (i = 0; i < 10; i++) {
      val = await this.readReg(SPI_CMD_REG) & SPI_CMD_USR;
      if (val === 0) {
        break;
      }
    }
    if (i === 10) {
      throw 'SPI command did not complete in time';
    }
    const stat = await this.readReg(SPI_W0_REG);
    // restore some SPI controller registers
    await this.writeReg(SPI_USR_REG, oldSpiUsr);
    await this.writeReg(SPI_USR2_REG, oldSpiUsr2);
    return stat;
  }

  // Read SPI flash manufacturer and device id
  async readFlashId() {
    const SPI_FLASH_RDID = 0x9F;
    const pkt = new Uint8Array(0);
    return this.runSpiFlashCommand(SPI_FLASH_RDID, pkt, 24);
  }

  // Erase entire flash chip (Stub only)
  // https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html#supported-by-stub-loader-only
  async eraseFlash() {
    if (!this.IS_STUB) throw new Error('Erase flash is a stub only command');
    this.log('Erasing flash (this may take a while)...');
    const t1 = Date.now();
    const ret = await this.checkCommand({
      opDescription: 'erase flash',
      op: this.ESP_ERASE_FLASH,
      timeout: this.CHIP_ERASE_TIMEOUT,
    });
    const t2 = Date.now();
    this.log(`Chip erase completed successfully in ${(t2 - t1) / 1000}s`);
    return ret;
  }

  // Calculate MD5 of flash region
  // https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html#commands
  async flashMd5sum(addr: number, size: number) {
    const timeout = this.#timeoutPerMb(this.MD5_TIMEOUT_PER_MB, size);
    let pkt = this.#appendArray(
      this.#intToByteArray(addr),
      this.#intToByteArray(size),
      this.#intToByteArray(0),
      this.#intToByteArray(0),
    );

    let res = await this.checkCommand({
      opDescription: 'calculate md5sum',
      op: this.ESP_SPI_FLASH_MD5,
      data: pkt,
      timeout,
    });
    if (typeof res === 'number') throw new Error('Invalid response to md5sum command');
    if (this.IS_STUB) {
      return res.subarray(0, 16).toString('hex');
    }
    return res.subarray(0, 32).toString('ascii');
  }

  // install a temporary stub loader to the device's memory and run it
  // https://docs.espressif.com/projects/esptool/en/latest/esp32/esptool/flasher-stub.html
  async runStub() {
    if (!this.chip) throw new Error('Chip not initialized');
    this.log(`Fetching ${this.chip.CHIP_NAME} stub...`);

    const stub = await this.stubLoader.loadStub(this.chip.CHIP_NAME);
    const {
      data, text, dataStart, textStart, entry,
    } = stub;

    this.log('Uploading stub...');

    let blocks = Math.floor((text.length + this.ESP_RAM_BLOCK - 1) / this.ESP_RAM_BLOCK);

    await this.memBegin(text.length, blocks, this.ESP_RAM_BLOCK, textStart);
    for (let i = 0; i < blocks; i++) {
      const fromOffs = i * this.ESP_RAM_BLOCK;
      let toOffs = fromOffs + this.ESP_RAM_BLOCK;
      if (toOffs > text.length) toOffs = text.length;
      await this.memBlock(text.subarray(fromOffs, toOffs), i);
    }

    blocks = Math.floor((data.length + this.ESP_RAM_BLOCK - 1) / this.ESP_RAM_BLOCK);

    await this.memBegin(data.length, blocks, this.ESP_RAM_BLOCK, dataStart);
    for (let i = 0; i < blocks; i++) {
      const fromOffs = i * this.ESP_RAM_BLOCK;
      let toOffs = fromOffs + this.ESP_RAM_BLOCK;
      if (toOffs > data.length) toOffs = data.length;
      await this.memBlock(data.subarray(fromOffs, toOffs), i);
    }

    this.log('Running stub...');
    let valid = false;
    const validCheck = (data: Buffer) => {
      if (data.toString('ascii').includes('OHAI')) valid = true;
    };
    this.serial.on('data', validCheck);

    await this.memFinish(entry);
    for (let i = 0; i < 10 && !valid; i++) {
      await this.#sleep(20);
    }
    
    this.serial.removeListener('data', validCheck);

    if (valid) {
      this.log('Stub running...');
      this.IS_STUB = true;
      this.FLASH_WRITE_SIZE = 0x4000;
      return this.chip;
    }
    this.log('Failed to start stub. Unexpected response');
    return null;
  }

  // initialise the device with the stub loader
  async mainFn() {
    await this.detectChip();
    if (this.chip == null) {
      this.log('Error in connecting to board');
      return;
    }

    const chip = await this.chip.getChipDescription(this);
    this.log(`Chip is ${chip}`);
    this.log(`Features: ${await this.chip.getChipFeatures(this)}`);
    this.log(`Crystal is ${await this.chip.getCrystalFreq(this)}MHz`);
    this.log(`MAC: ${await this.chip.readMac(this)}`);
    await this.chip.readMac(this);

    if (this.chip.IS_STUB) await this.runStub();
    else this.FLASH_WRITE_SIZE = this.chip.FLASH_WRITE_SIZE || 0x4000;
  }

  // finish writing to the device's memory, and run the code at the specified address
  // https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html#writing-data
  async changeBaudrate(newBaud: number) {
    this.log(`Changing baud rate to ${newBaud}...`);
    const oldBaud = this.IS_STUB ? this.serial.baudRate : 0;
    const pkt = this.#appendArray(this.#intToByteArray(newBaud), this.#intToByteArray(oldBaud));
    const res = await this.checkCommand({
      opDescription: 'change baudrate',
      op: this.ESP_CHANGE_BAUDRATE,
      data: pkt,
      timeout: 500,
    });
    await this.serial.update({ baudRate: newBaud });
    this.log('Changed.');
    return res;
  }

  // read a byte size from text
  #flashSizeBytes(flashSizeStr: string | number) {
    if (typeof flashSizeStr === 'number') return flashSizeStr;
    let flashSize = parseInt(flashSizeStr.replace(/\D/g, '') || '-1', 10);
    if (flashSizeStr.toLowerCase().includes('kb')) {
      return flashSize * 1024;
    }
    if (flashSizeStr.toLowerCase().includes('mb')) {
      return flashSize * 1024 * 1024;
    }
    if (flashSizeStr.toLowerCase().includes('gb')) {
      return flashSize * 1024 * 1024 * 1024;
    }
    return flashSize;
  }

  // resolve a byte size from text, using a list of possible sizes depending on the chip
  #parseFlashSizeArg(flashSizeStr: string) {
    if (!this.chip) throw new Error('Chip not initialized');
    const size = this.chip.FLASH_SIZES[flashSizeStr.toUpperCase()];
    if (typeof size !== 'number') {
      this.log(`Flash size ${flashSizeStr} is not supported by this chip type.`);
      this.log(`Supported sizes: ${Object.keys(this.chip.FLASH_SIZES).join(', ')}`);
      throw new Error('Invalid flash size');
    }
    return size;
  }

  // set the flash modes for an image
  // https://docs.espressif.com/projects/esptool/en/latest/esp32/esptool/flash-modes.html
  // https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/spi-flash-modes.html
  #updateImageFlashParams = (image: Buffer, address: number, flashSize: string, flashMode: string, flashFreq: string) => {
    if (!this.chip) throw new Error('Chip not initialized');
    // console.log(`_update_image_flashParams ${flashSize} ${flashMode} ${flashFreq}`);
    if (image.length < 8) return image;
    if (address !== this.chip.BOOTLOADER_FLASH_OFFSET) return image;
    if (flashSize === 'keep' && flashMode === 'keep' && flashFreq === 'keep') {
      // console.log('Not changing the image');
      return image;
    }

    const magic = image[0];
    let aFlashMode = image[2];
    const flashSizeFreq = image[3];
    if (magic !== this.ESP_IMAGE_MAGIC) {
      this.log(`Warning: Image file at 0x${
        address.toString(16)
      } doesn't look like an image file, so not changing any flash settings.`);
      return image;
    }

    /* XXX: Yet to implement actual image verification */

    if (flashMode !== 'keep') {
      const flashModes = {
        qio: 0, qout: 1, dio: 2, dout: 3,
      } as { [key: string]: number };
      aFlashMode = flashModes[flashMode];
    }
  
    let aFlashFreq = flashSizeFreq & 0x0F;
    if (flashFreq !== 'keep') {
      const flashFreqs = {
        '40m': 0, '26m': 1, '20m': 2, '80m': 0xf,
      } as { [key: string]: number };
      aFlashFreq = flashFreqs[flashFreq];
    }

    let aFlashSize = flashSizeFreq & 0xF0;
    if (flashSize !== 'keep') {
      aFlashSize = this.#parseFlashSizeArg(flashSize);
    }

    const flashParams = (aFlashMode << 8) | (aFlashFreq + aFlashSize);
    if (aFlashMode !== image[2] || (aFlashFreq + aFlashSize) !== image[3]) {
      this.log(`Flash params set to ${flashParams.toString(16).padStart(4, '0')}`);
      image.set([(aFlashMode), (aFlashFreq + aFlashSize)], 2);
    }
    return image;
  }

  // pad a buffer to a specific size
  #padTo(data: Buffer, alignment: number, padCharacter = 0xFF) {
    const padLength = alignment - (data.length % alignment);
    if (padLength === alignment) return data;
    const pad = Buffer.alloc(padLength, padCharacter);
    return Buffer.concat([data, pad]);
  }

  // write a list of image files to the device's flash
  async writeFlash({
    fileArray = [] as UploadFileDef[],
    flashSize = 'keep',
    flashMode = 'keep',
    flashFreq = 'keep',
    eraseAll = false,
    compress = true,
  } = {}) {
    if (!this.chip) throw new Error('Chip not initialized, make sure you call connect() first');

    if (flashSize !== 'keep') {
      const flashEnd = this.#flashSizeBytes(flashSize);
      fileArray.forEach((file) => {
        if ((file.data.length + file.address) > flashEnd) {
          throw new Error('Specified file doesn\'t fit in the available flash');
        }
      });
    }

    if (this.IS_STUB && eraseAll) {
      await this.eraseFlash();
    }
    for (let i = 0; i < fileArray.length; i += 1) {
      const file = fileArray[i];
      if (!this.chip) throw new Error('Chip not initialized');
      const { address } = file;
      // console.log(`Data Length ${fileArray[i].data.length}`);
      // image = this.pad_array(fileArray[i].data, Math.floor((fileArray[i].data.length + 3)/4) * 4, 0xff);
      // XXX : handle padding
      // console.log(`Image Length ${image.length}`);
      if (file.data.length === 0) {
        this.log('Warning: File is empty');
        break;
      }
      let image = this.#padTo(file.data, 4);
      image = this.#updateImageFlashParams(image, address, flashSize, flashMode, flashFreq);
      // const calcMd5 = CryptoJS.MD5(CryptoJS.enc.Base64.parse(image.toString('base64')));
      const calcMd5 = MD5(encBase64.parse(image.toString('base64'))).toString() as string;
      // console.log(`Image MD5 ${calcMd5}`);
      const rawSize = image.length;
      let blocks;
      if (compress) {
        image = Buffer.from(pako.deflate(image, { level: 9 }));
        blocks = await this.flashDeflBegin(rawSize, image.length, address);
      } else {
        blocks = await this.flashBegin(rawSize, address);
      }
      let seq = 0;
      let bytesSent = 0;
      // const bytes_written = 0;

      const t1 = Date.now();

      let timeout = 5000;
      while (image.length > 0) {
        // console.log(`Write loop ${address} ${seq} ${blocks}`);
        this.logChar(`\rWriting at 0x${
          (address + (seq * this.FLASH_WRITE_SIZE)).toString(16)
        }... (${
          Math.floor(100 * ((seq + 1) / blocks))
        }%)`);
        let block = image.subarray(0, this.FLASH_WRITE_SIZE);
        if (compress) {
          /*
            let block_uncompressed = pako.inflate(block).length;
            //let len_uncompressed = block_uncompressed.length;
            bytes_written += block_uncompressed;
            if (this.#timeoutPerMb(this.ERASE_WRITE_TIMEOUT_PER_MB, block_uncompressed) > 3000) {
                block_timeout = this.#timeoutPerMb(this.ERASE_WRITE_TIMEOUT_PER_MB, block_uncompressed);
            } else {
                block_timeout = 3000;
            } */ // XXX: Partial block inflate seems to be unsupported in Pako. Hardcoding timeout
          const blockTimeout = 5000;
          if (!this.IS_STUB) {
            timeout = blockTimeout;
          }
          await this.flashDeflBlock(block, seq, timeout);
          if (this.IS_STUB) {
            timeout = blockTimeout;
          }
        } else {
          // this.log('Yet to handle Non Compressed writes');
          // block = block + b'\xff' * (esp.FLASH_WRITE_SIZE - len(block))
          if (block.length < this.FLASH_WRITE_SIZE) {
            const existingBlock = block.toString('base64');
            block = Buffer.alloc(this.FLASH_WRITE_SIZE, 0xff);
            block.write(existingBlock, 'base64');
          }
          // if encrypted:
          //     esp.flash_encrypt_block(block, seq)
          // else:
          //     esp.flashBlock(block, seq)
          // bytes_written += len(block)
          await this.flashBlock(block, seq, timeout);
        }
        bytesSent += block.length;
        image = image.subarray(this.FLASH_WRITE_SIZE, image.length);
        seq++;
      }
      if (this.IS_STUB) {
        await this.readReg(this.CHIP_DETECT_MAGIC_REG_ADDR, timeout);
      }
      const t = Date.now() - t1;
      this.log('');
      this.log(`Wrote ${rawSize} bytes${
        compress ? ` (${bytesSent} compressed)` : ''
      } at 0x${address.toString(16)} in ${t / 1000} seconds.`);

      await this.#sleep(100);
      if (this.IS_STUB || this.chip.CHIP_NAME !== 'ESP8266') {
        const res = await this.flashMd5sum(address, rawSize);
        if (`${res}` !== `${calcMd5}`) {
          this.log(`File  md5: ${calcMd5}`);
          this.log(`Flash md5: ${res}`);
        } else {
          this.log('Hash of data verified.');
        }
      }
    }
    this.log('Leaving...');

    if (this.IS_STUB) {
      await this.flashBegin(0, 0);
      if (compress) {
        await this.flashDeflFinish();
      } else {
        await this.flashFinish();
      }
    }
  }

  // read the device's manufacturer and device ID and log them
  async flashId() {
    // console.log('flash_id');
    const flashId = await this.readFlashId();
    this.log(`Manufacturer: ${(flashId & 0xff).toString(16)}`);
    const idLowByte = (flashId >> 16) & 0xff;
    this.log(`Device: ${((flashId >> 8) & 0xff).toString(16)}${idLowByte.toString(16)}`);
    this.log(`Detected flash size: ${this.DETECTED_FLASH_SIZES[idLowByte] || 'Unknown'}`);
  }

  // reboot the device
  async reboot() {
    await this.serial.set({ dtr: false, rts: true });
    await this.#sleep(100);
    await this.serial.set({ dtr: false, rts: false });
    await this.#sleep(100);
  }
}
