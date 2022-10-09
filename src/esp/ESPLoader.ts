import { SerialPort } from 'serialport/dist/index.d';
import pako from 'pako';
import CryptoJS from 'crypto-js';
import StubLoader from './StubLoader';
import roms from './roms';
import ROM from './roms/rom';

export interface ESPOptions {
  quiet?: boolean;
  stubUrl?: string;
  stdout?: any;
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
    
    ESP_WRITE_REG = 0x09;

    ESP_FLASH_DEFL_BEGIN = 0x10;

    ESP_FLASH_DEFL_DATA = 0x11;

    ESP_FLASH_DEFL_END = 0x12;

    ESP_SPI_FLASH_MD5 = 0x13;

    ESP_READ_REG = 0x0A;

    ESP_SPI_ATTACH = 0x0D;

    // Only Stub supported commands
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
    serial: SerialPort;
    IS_STUB: boolean;
    chip: ROM | null;
    stdout: any;
    stubLoader: StubLoader;
    syncStubDetected: boolean;
    FLASH_WRITE_SIZE: number;
  
    constructor(serial: SerialPort, opts: ESPOptions) {
      this.opts = opts || {};
      this.quiet = this.opts.quiet || false;
      this.serial = serial;
      this.IS_STUB = false;
      this.chip = null;
      this.stdout = opts.stdout || process?.stdout || {
        write: (str: string) => console.log(str),
      };
      this.stubLoader = new StubLoader(this.opts.stubUrl);
      this.syncStubDetected = false;
      this.FLASH_WRITE_SIZE = 0x4000
    }

    #sleep(ms: number) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    log (...args: any[]) {
      if (this.quiet) return;
      this.stdout.write(`${args.map(arg => `${arg}`).join(' ')}\n`);
    }

    logChar(str: string) {
      if (this.stdout) {
        this.stdout.write(str);
      } else {
        // eslint-disable-next-line no-console
        console.log(str);
      }
    }

    #shortToByteArray(i: number) {
      return new Uint8Array([i & 0xff, (i >> 8) & 0xff]);
    }

    #intToByteArray(i: number) {
      return new Uint8Array([i & 0xff, (i >> 8) & 0xff, (i >> 16) & 0xff, (i >> 24) & 0xff]);
    }

    #byteArrayToShort(arr: [number, number]) {
      const [i, j] = arr;
      return (new Uint16Array([(i | (j >> 8))]))[0];
    }

    #byteArrayToInt(arr: [number, number, number, number]) {
      const [i, j, k, l] = arr;
      return (new Uint32Array([(i | (j << 8) | (k << 16) | (l << 24))]))[0];
    }

    #appendArray(arr1: Uint8Array, arr2: Uint8Array) {
      const c = new Uint8Array(arr1.length + arr2.length);
      c.set(arr1, 0);
      c.set(arr2, arr1.length);
      return c;
    }

    #flushInput = async () => {
      try {
        await this.serial.flush();
      } catch (e) {}
    }

    // convert data before sending to https://en.wikipedia.org/wiki/Serial_Line_Internet_Protocol
    async write(data: Buffer) {
      const slippedArr = [];
      for (let i = 0; i < data.length; i++) {
        if (i === 0xC0) slippedArr.push(0xDB, 0xDC); // escape the end char
        else if (i === 0xDB) slippedArr.push(0xDB, 0xDD); // escape the escape char
        else slippedArr.push(data[i]);
      }
      const pkt = Buffer.from([
        0xC0,
        ...slippedArr,
        0xC0,
      ]);
      return this.serial.write(pkt);
    }

    read(timeout = 0, flush = false): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        let started = false;
        let timeoutId = null as NodeJS.Timeout | null;
        let handleChunk = (data: Buffer) => {};
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
        handleChunk = (data: Buffer) => {
          if (flush) {
            Buffer.concat([buffer, data]);
            return;
          }
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
          if (pkt.length) buffer = Buffer.concat([buffer, new Uint8Array(pkt)]);
          if (buffer.length && !started) {
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

    async command({
      op = null as number | null,
      data = [] as number[] | Uint8Array | Buffer,
      chk = 0,
      waitResponse = true,
      timeout = 3000,
      // min_data = 12,
    } = {}): Promise<[number, Buffer]> {
      // console.log("command "+ op + " " + wait_response + " " + timeout);
      if (op) {
        const pkt = Buffer.from([
          0x00,
          op,
          ...this.#shortToByteArray(data.length), // 2-3
          ...this.#intToByteArray(chk), // 4-7
          ...data, // 8+
        ]);
        // console.log("Command " + pkt);
        await this.serial.write(pkt);
      }

      if (waitResponse) {
          const p = await this.read(timeout);
          // console.log(this.transport.slip_reader_enabled, p);
          // const resp = p[0];
          const op_ret = p[1];
          // const len_ret = this._bytearray_to_short(p[2], p[3]);
          const val = this.#byteArrayToInt([p[4], p[5], p[6], p[7]]);
          // eslint-disable-next-line no-console
          // console.log(`Resp ${resp} ${op_ret} ${op} ${len_ret} ${val} ${p}`);
          const datum = p.subarray(8);
          if (!op || op_ret === op) {
            return [val, datum];
          }
          throw new Error(`Invalid response. Expected ${op.toString(16)}`);
      }
      return [0, Buffer.from([])];
    }

    async readReg(addr: number, timeout = 3000) {
      // console.log(`read reg ${addr} ${timeout}`);
      const pkt = this.#intToByteArray(addr);
      const val = await this.command({ op: this.ESP_READ_REG, data: pkt, timeout });
      // console.log('Read reg resp', val);
      return val[0];
    }

    async writeReg(addr: number, value: number, mask = 0xFFFFFFFF, delayUs = 0, delayAfterUs = 0) {
      if (!this.chip) throw new Error('Chip not initialized');
      let pkt = this.#appendArray(this.#intToByteArray(addr), this.#intToByteArray(value));
      pkt = this.#appendArray(pkt, this.#intToByteArray(mask));
      pkt = this.#appendArray(pkt, this.#intToByteArray(delayUs));

      if (delayAfterUs > 0) {
        pkt = this.#appendArray(pkt, this.#intToByteArray(this.chip.UART_DATE_REG_ADDR));
        pkt = this.#appendArray(pkt, this.#intToByteArray(0));
        pkt = this.#appendArray(pkt, this.#intToByteArray(0));
        pkt = this.#appendArray(pkt, this.#intToByteArray(delayAfterUs));
      }

      await this.checkCommand({ opDescription: 'write target memory', op: this.ESP_WRITE_REG, data: pkt });
    }

    async sync() {
      // console.log('Sync');
      const cmd = new Uint8Array(36);
      let i;
      cmd[0] = 0x07;
      cmd[1] = 0x07;
      cmd[2] = 0x12;
      cmd[3] = 0x20;
      for (i = 0; i < 32; i++) {
        cmd[4 + i] = 0x55;
      }

      const resp = await this.command({ op: 0x08, data: cmd, timeout: 100 });
      this.syncStubDetected = resp[0] === 0;
      return resp;
    }

    async #connectAttempt({ mode = 'default_reset', esp32r0Delay = false } = {}) {
      // console.log(`_connect_attempt ${esp32r0Delay}`);
      if (mode !== 'no_reset') {
        await this.serial.set({ dtr: false, rts: true });
        await this.#sleep(100);
        if (esp32r0Delay) {
          // await this._sleep(1200);
          await this.#sleep(2000);
        }
        await this.serial.set({ dtr: true, rts: false });
        if (esp32r0Delay) {
          // await this._sleep(400);
        }
        await this.#sleep(50);
        await this.serial.set({ dtr: false });
      }
      let i = 0;
      // eslint-disable-next-line no-constant-condition
      while (1) {
        try {
          const res = await this.read(1000, true);
          i += res.length;
          // console.log("Len = " + res.length);
          // var str = new TextDecoder().decode(res);
          // this.log(str);
        } catch (err) {
          if (err instanceof Error && err.message.includes('timeout')) {
            break;
          }
        }
        await this.#sleep(50);
      }
      // this.transport.slip_reader_enabled = true;
      i = 7;
      while (i--) {
        try {
          await this.sync();
          return 'success';
        } catch (err) {
          if (err instanceof Error && err.message.includes('timeout')) {
            this.logChar(esp32r0Delay ? '_' : '.');
          }
        }
        await this.#sleep(50);
      }
      return 'error';
    }

    // eslint-disable-next-line no-unused-vars
    async connect({ mode = 'default_reset', attempts = 7, detecting = false } = {}) {
      let resp = '';
      this.logChar('Connecting...');
      // await this.transport.connect();
      await (new Array(attempts)).fill(0).reduce(async (promise) => {
        await promise;
        if (resp === 'success') return;
        resp = await this.#connectAttempt({ esp32r0Delay: false });
        if (resp === 'success') return;
        resp = await this.#connectAttempt({ esp32r0Delay: true });
        if (resp === 'success') return;
      }, Promise.resolve());
      if (resp !== 'success') {
        this.log('Failed to connect with the device');
        return 'error';
      }
      this.logChar('\n');
      this.logChar('\r');
      await this.#sleep(100);
      await this.#flushInput();

      if (!detecting) {
        const chipMagicValue = await this.readReg(0x40001000);
        // eslint-disable-next-line no-console
        // console.log(`Chip Magic ${chip_magic_value}`);
        this.chip = roms.find((cls) => chipMagicValue === cls.CHIP_DETECT_MAGIC_VALUE) ?? null;
        // console.log('chip', this.chip);
      }
      return null;
    }

    async detectChip() {
      await this.connect();
      this.logChar('Detecting chip type... ');
      if (this.chip !== null) {
        this.log(this.chip.CHIP_NAME);
      }
    }

    async checkCommand({
      // eslint-disable-next-line no-unused-vars
      opDescription = '',
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

    async memBegin(size: number, blocks: number, blocksize: number, offset: number) {
      /* XXX: Add check to ensure that STUB is not getting overwritten */
      // console.log(`memBegin ${size} ${blocks} ${blocksize} ${offset}`);
      let pkt = this.#appendArray(this.#intToByteArray(size), this.#intToByteArray(blocks));
      pkt = this.#appendArray(pkt, this.#intToByteArray(blocksize));
      pkt = this.#appendArray(pkt, this.#intToByteArray(offset));
      await this.checkCommand({ opDescription: 'write to target RAM', op: this.ESP_MEM_BEGIN, data: pkt });
    }

    checksum(data: number[] | Uint8Array | Buffer) {
      let i;
      let chk = 0xEF;

      for (i = 0; i < data.length; i++) {
        chk ^= data[i];
      }
      return chk;
    }

    async memBlock(buffer: Uint8Array, seq: number) {
      let pkt = this.#appendArray(this.#intToByteArray(buffer.length), this.#intToByteArray(seq));
      pkt = this.#appendArray(pkt, this.#intToByteArray(0));
      pkt = this.#appendArray(pkt, this.#intToByteArray(0));
      pkt = this.#appendArray(pkt, buffer);
      const checksum = this.checksum(buffer);
      await this.checkCommand({
        opDescription: 'write to target RAM', op: this.ESP_MEM_DATA, data: pkt, chk: checksum,
      });
    }

    async memFinish(entrypoint: number) {
      const is_entry = (entrypoint === 0) ? 1 : 0;
      const pkt = this.#appendArray(this.#intToByteArray(is_entry), this.#intToByteArray(entrypoint));
      return this.checkCommand({
        opDescription: 'leave RAM download mode',
        op: this.ESP_MEM_END,
        data: pkt,
        timeout: 500,
        // min_data: 12,
      }); // XXX: handle non-stub with diff timeout
    }

    async flashSpiAttach(hspiArg: number) {
      const pkt = this.#intToByteArray(hspiArg);
      await this.checkCommand({ opDescription: 'configure SPI flash pins', op: this.ESP_SPI_ATTACH, data: pkt });
    }

    timeoutPerMb(secondsPerMb: number, sizeBytes: number) {
      const result = secondsPerMb * (sizeBytes / 1000000);
      if (result < 3000) {
        return 3000;
      }
      return result;
    }

    async flashBegin(size: number, offset: number) {
      if (!this.chip) throw new Error('chip not initialized');
      const numBlocks = Math.floor((size + this.FLASH_WRITE_SIZE - 1) / this.FLASH_WRITE_SIZE);
      const eraseSize = this.chip.getEraseSize(offset, size);

      const d = new Date();
      const t1 = d.getTime();

      let timeout = 3000;
      if (this.IS_STUB === false) {
        timeout = this.timeoutPerMb(this.ERASE_REGION_TIMEOUT_PER_MB, size);
      }

      // eslint-disable-next-line no-console
      // console.log(`flash begin ${eraseSize} ${numBlocks} ${this.FLASH_WRITE_SIZE} ${offset} ${size}`);
      let pkt = this.#appendArray(this.#intToByteArray(eraseSize), this.#intToByteArray(numBlocks));
      pkt = this.#appendArray(pkt, this.#intToByteArray(this.FLASH_WRITE_SIZE));
      pkt = this.#appendArray(pkt, this.#intToByteArray(offset));
      if (this.IS_STUB === false) {
        pkt = this.#appendArray(pkt, this.#intToByteArray(0)); // XXX: Support encrypted
      }

      await this.checkCommand({
        opDescription: 'enter Flash download mode', op: this.ESP_FLASH_BEGIN, data: pkt, timeout,
      });

      const t2 = d.getTime();
      if (size !== 0 && this.IS_STUB === false) {
        this.log(`Took ${(t2 - t1) / 1000}.${(t2 - t1) % 1000}s to erase flash block`);
      }
      return numBlocks;
    }

    async flashDeflBegin(size: number, compSize: number, offset: number) {
      if (!this.chip) throw new Error('chip not initialized');
      const numBlocks = Math.floor((compSize + this.FLASH_WRITE_SIZE - 1) / this.FLASH_WRITE_SIZE);
      const eraseBlocks = Math.floor((size + this.FLASH_WRITE_SIZE - 1) / this.FLASH_WRITE_SIZE);

      const t1 = Date.now();

      let writeSize;
      let timeout;
      if (this.IS_STUB) {
        writeSize = size;
        timeout = 3000;
      } else {
        writeSize = eraseBlocks * this.FLASH_WRITE_SIZE;
        timeout = this.timeoutPerMb(this.ERASE_REGION_TIMEOUT_PER_MB, writeSize);
      }
      this.log(`Compressed ${size} bytes to ${compSize}...`);

      let pkt = this.#appendArray(this.#intToByteArray(writeSize), this.#intToByteArray(numBlocks));
      pkt = this.#appendArray(pkt, this.#intToByteArray(this.FLASH_WRITE_SIZE));
      pkt = this.#appendArray(pkt, this.#intToByteArray(offset));

      if (
        (this.chip.CHIP_NAME === 'ESP32-S2' || this.chip.CHIP_NAME === 'ESP32-S3' || this.chip.CHIP_NAME === 'ESP32-C3')
        && (this.IS_STUB === false)
      ) {
        pkt = this.#appendArray(pkt, this.#intToByteArray(0));
      }
      if (this.chip.CHIP_NAME === 'ESP8266') {
        await this.#flushInput();
      }
      await this.checkCommand({
        opDescription: 'enter compressed flash mode', op: this.ESP_FLASH_DEFL_BEGIN, data: pkt, timeout,
      });
      const t2 = Date.now();
      if (size !== 0 && this.IS_STUB === false) {
        this.log(`Took ${(t2 - t1) / 1000}.${(t2 - t1) % 1000}s to erase flash block`);
      }
      return numBlocks;
    }

    async flashBlock(data: Uint8Array, seq: number, timeout: number) {
      let pkt = this.#appendArray(this.#intToByteArray(data.length), this.#intToByteArray(seq));
      pkt = this.#appendArray(pkt, this.#intToByteArray(0));
      pkt = this.#appendArray(pkt, this.#intToByteArray(0));
      pkt = this.#appendArray(pkt, data);

      const checksum = this.checksum(data);

      await this.checkCommand({
        opDescription: `write to target Flash after seq ${seq}`, op: this.ESP_FLASH_DATA, data: pkt, chk: checksum, timeout,
      });
    }

    async flashDeflBlock(data: Uint8Array, seq: number, timeout: number) {
      let pkt = this.#appendArray(this.#intToByteArray(data.length), this.#intToByteArray(seq));
      pkt = this.#appendArray(pkt, this.#intToByteArray(0));
      pkt = this.#appendArray(pkt, this.#intToByteArray(0));
      pkt = this.#appendArray(pkt, data);

      const checksum = this.checksum(data);
      // console.log(`flashDeflBlock ${data[0].toString(16)}`, +' ' + data[1].toString(16));

      await this.checkCommand({
        opDescription: `write compressed data to flash after seq ${seq}`,
        op: this.ESP_FLASH_DEFL_DATA,
        data: pkt,
        chk: checksum,
        timeout,
      });
    }

    async flashFinish({ reboot = false } = {}) {
      const val = reboot ? 0 : 1;
      const pkt = this.#intToByteArray(val);

      await this.checkCommand({ opDescription: 'leave Flash mode', op: this.ESP_FLASH_END, data: pkt });
    }

    async flashDeflFinish({ reboot = false } = {}) {
      const val = reboot ? 0 : 1;
      const pkt = this.#intToByteArray(val);

      await this.checkCommand({ opDescription: 'leave compressed flash mode', op: this.ESP_FLASH_DEFL_END, data: pkt });
    }

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
      if (this.chip.SPI_MOSI_DLEN_OFFS != null) {
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

      const SPI_CMD_USR = (1 << 18);
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
        await this.writeReg(SPI_W0_REG, 0);
      } else {
        if (data.length % 4 !== 0) {
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
      await this.writeReg(SPI_USR_REG, oldSpiUsr);
      await this.writeReg(SPI_USR2_REG, oldSpiUsr2);
      return stat;
    }

    async readFlashId() {
      const SPI_FLASH_RDID = 0x9F;
      const pkt = new Uint8Array(0);
      return this.runSpiFlashCommand(SPI_FLASH_RDID, pkt, 24);
    }

    async eraseFlash() {
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

    async flashMd5sum(addr: number, size: number) {
      const timeout = this.timeoutPerMb(this.MD5_TIMEOUT_PER_MB, size);
      let pkt = this.#appendArray(this.#intToByteArray(addr), this.#intToByteArray(size));
      pkt = this.#appendArray(pkt, this.#intToByteArray(0));
      pkt = this.#appendArray(pkt, this.#intToByteArray(0));

      let res = await this.checkCommand({
        opDescription: 'calculate md5sum', op: this.ESP_SPI_FLASH_MD5, data: pkt, timeout, // min_data: 26,
      });
      if (typeof res === 'number') throw new Error('Invalid response to md5sum command');
      if (res.length > 16) {
        res = res.subarray(0, 16);
      }
      const strmd5 = res.toString('hex');
      return strmd5;
    }

    async runStub() {
      if (!this.chip) throw new Error('Chip not initialized');
      this.log('Fetching stub...');

      const stub = await this.stubLoader.loadStub(this.chip.CHIP_NAME);
      // console.log(stub);
      const {
        data, text, dataStart, textStart, entry,
      } = stub;

      this.log('Uploading stub...');

      let blocks = Math.floor((text.length + this.ESP_RAM_BLOCK - 1) / this.ESP_RAM_BLOCK);
      let i;

      await this.memBegin(text.length, blocks, this.ESP_RAM_BLOCK, textStart);
      for (i = 0; i < blocks; i++) {
        const fromOffs = i * this.ESP_RAM_BLOCK;
        let toOffs = fromOffs + this.ESP_RAM_BLOCK;
        if (toOffs > text.length) toOffs = text.length;
        await this.memBlock(text.subarray(fromOffs, toOffs), i);
      }

      blocks = Math.floor((data.length + this.ESP_RAM_BLOCK - 1) / this.ESP_RAM_BLOCK);
      await this.memBegin(data.length, blocks, this.ESP_RAM_BLOCK, dataStart);
      for (i = 0; i < blocks; i++) {
        const fromOffs = i * this.ESP_RAM_BLOCK;
        let toOffs = fromOffs + this.ESP_RAM_BLOCK;
        if (toOffs > data.length) toOffs = data.length;
        await this.memBlock(data.subarray(fromOffs, toOffs), i);
      }

      this.log('Running stub...');
      let valid = false;
      await this.memFinish(entry);

      if (this.chip.CHIP_NAME === 'ESP8266') {
        const [reply] = await this.sync();
        if (reply === 0) valid = true;
      } else {
        const res = await this.serial.read(6); // { timeout: 1000, min_data: 6 });
        if (res[0] === 79 && res[1] === 72 && res[2] === 65 && res[3] === 73) {
          valid = true;
        }
      }

      if (valid) {
        this.log('Stub running...');
        this.IS_STUB = true;
        this.FLASH_WRITE_SIZE = 0x4000;
        return this.chip;
      }
      this.log('Failed to start stub. Unexpected response');
      return null;
    }

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

    flashSizeBytes(flashSize: string) {
      let flashSizeB = -1;
      if (flashSize.indexOf('KB') !== -1) {
        flashSizeB = parseInt(flashSize.slice(0, flashSize.indexOf('KB')), 10) * 1024;
      } else if (flashSize.indexOf('MB') !== -1) {
        flashSizeB = parseInt(flashSize.slice(0, flashSize.indexOf('MB')), 10) * 1024 * 1024;
      }
      return flashSizeB;
    }

    padArray(arr: any[], len: number, fillValue: any) {
      return Object.assign(new Array(len).fill(fillValue), arr);
    }

    parseFlashSizeArg(flashSize: string) {
      if (!this.chip) throw new Error('Chip not initialized');
      if (!this.chip.FLASH_SIZES[flashSize]) {
        this.log(`Flash size ${flashSize} is not supported by this chip type. Supported sizes: ${this.chip.FLASH_SIZES}`);
        throw new Error('Invalid flash size');
      }
      return this.chip.FLASH_SIZES[flashSize];
    }

    #updateImageFlashParams = (image: Buffer, address: number, flashSize: string, flashMode: string, flashFreq: string) => {
      if (!this.chip) throw new Error('Chip not initialized');
      // console.log(`_update_image_flashParams ${flashSize} ${flashMode} ${flashFreq}`);
      if (image.length < 8) {
        return image;
      }
      if (address !== this.chip.BOOTLOADER_FLASH_OFFSET) {
        return image;
      }
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
        aFlashSize = this.parseFlashSizeArg(flashSize);
      }

      const flashParams = (aFlashMode << 8) | (aFlashFreq + aFlashSize);
      this.log(`Flash params set to ${flashParams.toString(16)}`);
      if (image[2] !== (aFlashMode << 8)) {
        // eslint-disable-next-line no-param-reassign
        image[2] = (aFlashMode << 8);
      }
      if (image[3] !== (aFlashFreq + aFlashSize)) {
        // eslint-disable-next-line no-param-reassign
        image[3] = (aFlashFreq + aFlashSize);
      }
      return image;
    }

    async writeFlash({
      fileArray = [] as UploadFileDef[],
      flashSize = 'keep',
      flashMode = 'keep',
      flashFreq = 'keep',
      eraseAll = false,
      compress = true,
    } = {}) {
      if (!this.chip) throw new Error('Chip not initialized, make sure you call connect() first');
      // console.log('EspLoader program');
      if (flashSize !== 'keep') {
        const flashEnd = this.flashSizeBytes(flashSize);
        fileArray.forEach((file) => {
          if ((file.data.length + file.address) > flashEnd) {
            throw new Error('Specified file doesn\'t fit in the available flash');
          }
        });
      }

      if (this.IS_STUB === true && eraseAll === true) {
        await this.eraseFlash();
      }
      await fileArray.reduce(async (prev, file) => {
        await prev;
        if (!this.chip) throw new Error('Chip not initialized');
        const { address } = file;
        // console.log(`Data Length ${fileArray[i].data.length}`);
        // image = this.pad_array(fileArray[i].data, Math.floor((fileArray[i].data.length + 3)/4) * 4, 0xff);
        // XXX : handle padding
        // console.log(`Image Length ${image.length}`);
        if (file.data.length === 0) {
          this.log('Warning: File is empty');
          return;
        }
        let image = this.#updateImageFlashParams(file.data, address, flashSize, flashMode, flashFreq);
        const calcmd5 = CryptoJS.MD5(CryptoJS.enc.Base64.parse(image.toString('base64')));
        // console.log(`Image MD5 ${calcmd5}`);
        const uncsize = image.length;
        let blocks;
        // console.log(image);
        if (compress) {
          // const uncimage = this.bstrToUi8(image);
          image = Buffer.from(pako.deflate(image, { level: 9 }));
          // console.log('Compressed image ');
          // console.log(image);
          blocks = await this.flashDeflBegin(uncsize, image.length, address);
        } else {
          blocks = await this.flashBegin(uncsize, address);
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
              if (this.timeoutPerMb(this.ERASE_WRITE_TIMEOUT_PER_MB, block_uncompressed) > 3000) {
                  block_timeout = this.timeoutPerMb(this.ERASE_WRITE_TIMEOUT_PER_MB, block_uncompressed);
              } else {
                  block_timeout = 3000;
              } */ // XXX: Partial block inflate seems to be unsupported in Pako. Hardcoding timeout
            const blockTimeout = 5000;
            if (this.IS_STUB === false) {
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
        this.log(`Wrote ${uncsize} bytes${
          compress ? ` (${bytesSent} compressed)` : ''
        } at 0x${address.toString(16)} in ${t / 1000} seconds.`);
        await this.#sleep(100);
        if (this.IS_STUB || this.chip.CHIP_NAME !== 'ESP8266') {
          const res = await this.flashMd5sum(address, uncsize);
          if (`${res}` !== `${calcmd5}`) {
            this.log(`File  md5: ${calcmd5}`);
            this.log(`Flash md5: ${res}`);
          } else {
            this.log('Hash of data verified.');
          }
        }
      }, Promise.resolve());
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

    async flashId() {
      // console.log('flash_id');
      const flashId = await this.readFlashId();
      this.log(`Manufacturer: ${(flashId & 0xff).toString(16)}`);
      const idLowByte = (flashId >> 16) & 0xff;
      this.log(`Device: ${((flashId >> 8) & 0xff).toString(16)}${idLowByte.toString(16)}`);
      this.log(`Detected flash size: ${this.DETECTED_FLASH_SIZES[idLowByte] || 'Unknown'}`);
    }
}
