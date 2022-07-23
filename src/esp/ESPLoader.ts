import { SerialPort } from 'serialport/dist/index.d';
import pako from 'pako';
import CryptoJS from 'crypto-js';
import StubLoader from './StubLoader';

interface ESPOptions {
  quiet?: boolean;
  stubUrl?: string;
  stdout?: any;
}

export default class ESPLoader {
    ESP_RAM_BLOCK = 0x1800;

    ESP_FLASH_BEGIN = 0x02;

    ESP_FLASH_DATA = 0x03;

    ESP_FLASH_END = 0x04;

    ESP_MEMBEGIN = 0x05;

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
    };

    opts: ESPOptions;
    quiet: boolean;
    serial: SerialPort;
    IS_STUB: boolean;
    chip: ROMDef | null;
    stdout: any;
    stubLoader: StubLoader;
    syncStubDetected: boolean;
  
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

    #ui8ToBstr(u8Array: Uint8Array) {
      let i;
      const len = u8Array.length;
      let b_str = '';
      for (i = 0; i < len; i++) {
        b_str += String.fromCharCode(u8Array[i]);
      }
      return b_str;
    }

    #bstrToUi8(bStr: string) {
      const len = bStr.length;
      const u8_array = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        u8_array[i] = bStr.charCodeAt(i);
      }
      return u8_array;
    }

    #flushInput = async () => {
      try {
        await this.serial.flush();
      } catch (e) {}
    }

    // convert data before sending to https://en.wikipedia.org/wiki/Serial_Line_Internet_Protocol
    async write(data: Buffer) {
      const slipped_arr = [];
      for (let i = 0; i < data.length; i++) {
        if (i === 0xC0) slipped_arr.push(0xDB, 0xDC); // escape the end char
        else if (i === 0xDB) slipped_arr.push(0xDB, 0xDD); // escape the escape char
        else slipped_arr.push(data[i]);
      }
      const pkt = Buffer.from([
        0xC0,
        ...slipped_arr,
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

    command = async ({
      op = null as number | null,
      data = [] as number[] | Uint8Array | Buffer,
      chk = 0,
      waitResponse = true,
      timeout = 3000,
      // min_data = 12,
    } = {}): Promise<[number, Buffer]> => {
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
          const datum = p.slice(8);
          if (!op || op_ret === op) {
            return [val, datum];
          }
          throw new Error(`Invalid response. Expected ${op.toString(16)}`);
      }
      return [0, Buffer.from([])];
    }

    readReg = async (addr: number, timeout = 3000) => {
      // console.log(`read reg ${addr} ${timeout}`);
      const pkt = this.#intToByteArray(addr);
      const val = await this.command({ op: this.ESP_READ_REG, data: pkt, timeout });
      // console.log('Read reg resp', val);
      return val[0];
    }

    writeReg = async (addr: number, value: number, mask = 0xFFFFFFFF, delay_us = 0, delay_after_us = 0) => {
      let pkt = this.#appendArray(this.#intToByteArray(addr), this.#intToByteArray(value));
      pkt = this.#appendArray(pkt, this.#intToByteArray(mask));
      pkt = this.#appendArray(pkt, this.#intToByteArray(delay_us));

      if (delay_after_us > 0) {
        pkt = this.#appendArray(pkt, this.#intToByteArray(this.chip.UART_DATE_REG_ADDR));
        pkt = this.#appendArray(pkt, this.#intToByteArray(0));
        pkt = this.#appendArray(pkt, this.#intToByteArray(0));
        pkt = this.#appendArray(pkt, this.#intToByteArray(delay_after_us));
      }

      await this.checkCommand({ op_description: 'write target memory', op: this.ESP_WRITE_REG, data: pkt });
    }

    sync = async () => {
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

    #connectAttempt = async ({ mode = 'default_reset', esp32r0_delay = false } = {}) => {
      // console.log(`_connect_attempt ${esp32r0_delay}`);
      if (mode !== 'no_reset') {
        await this.serial.set({ dtr: false, rts: true });
        await this.#sleep(100);
        if (esp32r0_delay) {
          // await this._sleep(1200);
          await this.#sleep(2000);
        }
        await this.serial.set({ dtr: true, rts: false });
        if (esp32r0_delay) {
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
            this.logChar(esp32r0_delay ? '_' : '.');
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
      let success = false;
      await (new Array(attempts)).fill(0).reduce(async (promise) => {
        await promise;
        if (resp === 'success') return;
        resp = await this.#connectAttempt({ esp32r0_delay: false });
        if (resp === 'success') return;
        resp = await this.#connectAttempt({ esp32r0_delay: true });
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
        const chip_magic_value = await this.readReg(0x40001000);
        // eslint-disable-next-line no-console
        // console.log(`Chip Magic ${chip_magic_value}`);
        const chips = [ESP8266ROM, ESP32ROM, ESP32S2ROM, ESP32S3BETA2ROM, ESP32C3ROM];
        this.chip = chips.find((cls) => chip_magic_value === cls.CHIP_DETECT_MAGIC_VALUE);
        // console.log('chip', this.chip);
      }
      return null;
    }

    async detectChip() {
      await this.connect();
      this.logChar('Detecting chip type... ');
      if (this.chip != null) {
        this.log(this.chip.CHIP_NAME);
      }
    }

    async checkCommand({
      // eslint-disable-next-line no-unused-vars
      op_description = '',
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
      await this.checkCommand({ op_description: 'write to target RAM', op: this.ESP_MEMBEGIN, data: pkt });
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
        op_description: 'write to target RAM', op: this.ESP_MEM_DATA, data: pkt, chk: checksum,
      });
    }

    mem_finish = async (entrypoint: number) => {
      const is_entry = (entrypoint === 0) ? 1 : 0;
      const pkt = this.#appendArray(this.#intToByteArray(is_entry), this.#intToByteArray(entrypoint));
      return this.checkCommand({
        op_description: 'leave RAM download mode', op: this.ESP_MEM_END, data: pkt, timeout: 500, min_data: 12,
      }); // XXX: handle non-stub with diff timeout
    }

    flash_spi_attach = async (hspi_arg) => {
      const pkt = this.#intToByteArray(hspi_arg);
      await this.checkCommand({ op_description: 'configure SPI flash pins', op: this.ESP_SPI_ATTACH, data: pkt });
    }

    timeout_per_mb = (seconds_per_mb, size_bytes) => {
      const result = seconds_per_mb * (size_bytes / 1000000);
      if (result < 3000) {
        return 3000;
      }
      return result;
    }

    flash_begin = async (size, offset) => {
      const num_blocks = Math.floor((size + this.FLASH_WRITE_SIZE - 1) / this.FLASH_WRITE_SIZE);
      const erase_size = this.chip.get_erase_size(offset, size);

      const d = new Date();
      const t1 = d.getTime();

      let timeout = 3000;
      if (this.IS_STUB === false) {
        timeout = this.timeout_per_mb(this.ERASE_REGION_TIMEOUT_PER_MB, size);
      }

      // eslint-disable-next-line no-console
      // console.log(`flash begin ${erase_size} ${num_blocks} ${this.FLASH_WRITE_SIZE} ${offset} ${size}`);
      let pkt = this.#appendArray(this.#intToByteArray(erase_size), this.#intToByteArray(num_blocks));
      pkt = this.#appendArray(pkt, this.#intToByteArray(this.FLASH_WRITE_SIZE));
      pkt = this.#appendArray(pkt, this.#intToByteArray(offset));
      if (this.IS_STUB === false) {
        pkt = this.#appendArray(pkt, this.#intToByteArray(0)); // XXX: Support encrypted
      }

      await this.checkCommand({
        op_description: 'enter Flash download mode', op: this.ESP_FLASH_BEGIN, data: pkt, timeout,
      });

      const t2 = d.getTime();
      if (size !== 0 && this.IS_STUB === false) {
        this.log(`Took ${(t2 - t1) / 1000}.${(t2 - t1) % 1000}s to erase flash block`);
      }
      return num_blocks;
    }

    flash_defl_begin = async (size, compsize, offset) => {
      const num_blocks = Math.floor((compsize + this.FLASH_WRITE_SIZE - 1) / this.FLASH_WRITE_SIZE);
      const erase_blocks = Math.floor((size + this.FLASH_WRITE_SIZE - 1) / this.FLASH_WRITE_SIZE);

      const d = new Date();
      const t1 = d.getTime();

      let write_size; let
        timeout;
      if (this.IS_STUB) {
        write_size = size;
        timeout = 3000;
      } else {
        write_size = erase_blocks * this.FLASH_WRITE_SIZE;
        timeout = this.timeout_per_mb(this.ERASE_REGION_TIMEOUT_PER_MB, write_size);
      }
      this.log(`Compressed ${size} bytes to ${compsize}...`);

      let pkt = this.#appendArray(this.#intToByteArray(write_size), this.#intToByteArray(num_blocks));
      pkt = this.#appendArray(pkt, this.#intToByteArray(this.FLASH_WRITE_SIZE));
      pkt = this.#appendArray(pkt, this.#intToByteArray(offset));

      if (
        (this.chip.CHIP_NAME === 'ESP32-S2' || this.chip.CHIP_NAME === 'ESP32-S3' || this.chip.CHIP_NAME === 'ESP32-C3')
        && (this.IS_STUB === false)
      ) {
        pkt = this.#appendArray(pkt, this.#intToByteArray(0));
      }
      if (this.chip.CHIP_NAME === 'ESP8266') {
        await this.flush_input();
      }
      await this.checkCommand({
        op_description: 'enter compressed flash mode', op: this.ESP_FLASH_DEFL_BEGIN, data: pkt, timeout,
      });
      const t2 = d.getTime();
      if (size !== 0 && this.IS_STUB === false) {
        this.log(`Took ${(t2 - t1) / 1000}.${(t2 - t1) % 1000}s to erase flash block`);
      }
      return num_blocks;
    }

    flash_block = async (data, seq, timeout) => {
      let pkt = this.#appendArray(this.#intToByteArray(data.length), this.#intToByteArray(seq));
      pkt = this.#appendArray(pkt, this.#intToByteArray(0));
      pkt = this.#appendArray(pkt, this.#intToByteArray(0));
      pkt = this.#appendArray(pkt, data);

      const checksum = this.checksum(data);

      await this.checkCommand({
        op_description: `write to target Flash after seq ${seq}`, op: this.ESP_FLASH_DATA, data: pkt, chk: checksum, timeout,
      });
    }

    flash_defl_block = async (data, seq, timeout) => {
      let pkt = this.#appendArray(this.#intToByteArray(data.length), this.#intToByteArray(seq));
      pkt = this.#appendArray(pkt, this.#intToByteArray(0));
      pkt = this.#appendArray(pkt, this.#intToByteArray(0));
      pkt = this.#appendArray(pkt, data);

      const checksum = this.checksum(data);
      // console.log(`flash_defl_block ${data[0].toString(16)}`, +' ' + data[1].toString(16));

      await this.checkCommand({
        op_description: `write compressed data to flash after seq ${seq}`,
        op: this.ESP_FLASH_DEFL_DATA,
        data: pkt,
        chk: checksum,
        timeout,
      });
    }

    flash_finish = async ({ reboot = false } = {}) => {
      const val = reboot ? 0 : 1;
      const pkt = this.#intToByteArray(val);

      await this.checkCommand({ op_description: 'leave Flash mode', op: this.ESP_FLASH_END, data: pkt });
    }

    flash_defl_finish = async ({ reboot = false } = {}) => {
      const val = reboot ? 0 : 1;
      const pkt = this.#intToByteArray(val);

      await this.checkCommand({ op_description: 'leave compressed flash mode', op: this.ESP_FLASH_DEFL_END, data: pkt });
    }

    run_spiflash_command = async (spiflash_command, data, read_bits) => {
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

      let set_data_lengths;
      if (this.chip.SPI_MOSI_DLEN_OFFS != null) {
        set_data_lengths = async (mosi_bits, miso_bits) => {
          const SPI_MOSI_DLEN_REG = base + this.chip.SPI_MOSI_DLEN_OFFS;
          const SPI_MISO_DLEN_REG = base + this.chip.SPI_MISO_DLEN_OFFS;
          if (mosi_bits > 0) {
            await this.write_reg({ addr: SPI_MOSI_DLEN_REG, value: (mosi_bits - 1) });
          }
          if (miso_bits > 0) {
            await this.write_reg({ addr: SPI_MISO_DLEN_REG, value: (miso_bits - 1) });
          }
        };
      } else {
        set_data_lengths = async (mosi_bits, miso_bits) => {
          const SPI_DATA_LEN_REG = SPI_USR1_REG;
          const SPI_MOSI_BITLEN_S = 17;
          const SPI_MISO_BITLEN_S = 8;
          const mosi_mask = (mosi_bits === 0) ? 0 : (mosi_bits - 1);
          const miso_mask = (miso_bits === 0) ? 0 : (miso_bits - 1);
          const val = (miso_mask << SPI_MISO_BITLEN_S) | (mosi_mask << SPI_MOSI_BITLEN_S);
          await this.write_reg({ addr: SPI_DATA_LEN_REG, value: val });
        };
      }

      const SPI_CMD_USR = (1 << 18);
      const SPI_USR2_COMMAND_LEN_SHIFT = 28;
      if (read_bits > 32) {
        throw 'Reading more than 32 bits back from a SPI flash operation is unsupported';
      }
      if (data.length > 64) {
        throw 'Writing more than 64 bytes of data with one SPI command is unsupported';
      }

      const data_bits = data.length * 8;
      const old_spi_usr = await this.read_reg({ addr: SPI_USR_REG });
      const old_spi_usr2 = await this.read_reg({ addr: SPI_USR2_REG });
      let flags = SPI_USR_COMMAND;
      let i;
      if (read_bits > 0) {
        flags |= SPI_USR_MISO;
      }
      if (data_bits > 0) {
        flags |= SPI_USR_MOSI;
      }
      await set_data_lengths(data_bits, read_bits);
      await this.write_reg({ addr: SPI_USR_REG, value: flags });
      let val = (7 << SPI_USR2_COMMAND_LEN_SHIFT) | spiflash_command;
      await this.write_reg({ addr: SPI_USR2_REG, value: val });
      if (data_bits === 0) {
        await this.write_reg({ addr: SPI_W0_REG, value: 0 });
      } else {
        if (data.length % 4 !== 0) {
          const padding = new Uint8Array(data.length % 4);
          // eslint-disable-next-line no-param-reassign
          data = this.#appendArray(data, padding);
        }
        let next_reg = SPI_W0_REG;
        for (i = 0; i < data.length - 4; i += 4) {
          val = this.#byteArrayToInt(data[i], data[i + 1], data[i + 2], data[i + 3]);
          await this.write_reg({ addr: next_reg, value: val });
          next_reg += 4;
        }
      }
      await this.write_reg({ addr: SPI_CMD_REG, value: SPI_CMD_USR });
      for (i = 0; i < 10; i++) {
        val = await this.read_reg({ addr: SPI_CMD_REG }) & SPI_CMD_USR;
        if (val === 0) {
          break;
        }
      }
      if (i === 10) {
        throw 'SPI command did not complete in time';
      }
      const stat = await this.read_reg({ addr: SPI_W0_REG });
      await this.write_reg({ addr: SPI_USR_REG, value: old_spi_usr });
      await this.write_reg({ addr: SPI_USR2_REG, value: old_spi_usr2 });
      return stat;
    }

    read_flash_id = async () => {
      const SPIFLASH_RDID = 0x9F;
      const pkt = new Uint8Array(0);
      return this.run_spiflash_command(SPIFLASH_RDID, pkt, 24);
    }

    erase_flash = async () => {
      this.log('Erasing flash (this may take a while)...');
      let d = new Date();
      const t1 = d.getTime();
      const ret = await this.checkCommand({
        op_description: 'erase flash',
        op: this.ESP_ERASE_FLASH,
        timeout: this.CHIP_ERASE_TIMEOUT,
      });
      d = new Date();
      const t2 = d.getTime();
      this.log(`Chip erase completed successfully in ${(t2 - t1) / 1000}s`);
      return ret;
    }

    toHex(buffer) {
      return Array.prototype.map.call(buffer, (x) => (`00${x.toString(16)}`).slice(-2)).join('');
    }

    flash_md5sum = async (addr, size) => {
      const timeout = this.timeout_per_mb(this.MD5_TIMEOUT_PER_MB, size);
      let pkt = this.#appendArray(this.#intToByteArray(addr), this.#intToByteArray(size));
      pkt = this.#appendArray(pkt, this.#intToByteArray(0));
      pkt = this.#appendArray(pkt, this.#intToByteArray(0));

      let res = await this.checkCommand({
        op_description: 'calculate md5sum', op: this.ESP_SPI_FLASH_MD5, data: pkt, timeout, min_data: 26,
      });
      if (res.length > 16) {
        res = res.slice(0, 16);
      }
      const strmd5 = this.toHex(res);
      return strmd5;
    }

    run_stub = async () => {
      this.log('Fetching stub...');

      const stub = await this._loadStub();
      // console.log(stub);
      const {
        data, text, data_start, text_start, entry,
      } = stub;

      this.log('Uploading stub...');

      let blocks = Math.floor((text.length + this.ESP_RAM_BLOCK - 1) / this.ESP_RAM_BLOCK);
      let i;

      await this.memBegin(text.length, blocks, this.ESP_RAM_BLOCK, text_start);
      for (i = 0; i < blocks; i++) {
        const from_offs = i * this.ESP_RAM_BLOCK;
        let to_offs = from_offs + this.ESP_RAM_BLOCK;
        if (to_offs > text.length) to_offs = text.length;
        await this.memBlock(text.slice(from_offs, to_offs), i);
      }

      blocks = Math.floor((data.length + this.ESP_RAM_BLOCK - 1) / this.ESP_RAM_BLOCK);
      await this.memBegin(data.length, blocks, this.ESP_RAM_BLOCK, data_start);
      for (i = 0; i < blocks; i++) {
        const from_offs = i * this.ESP_RAM_BLOCK;
        let to_offs = from_offs + this.ESP_RAM_BLOCK;
        if (to_offs > data.length) to_offs = data.length;
        await this.memBlock(data.slice(from_offs, to_offs), i);
      }

      this.log('Running stub...');
      let valid = false;
      await this.mem_finish(entry);

      if (this.chip.CHIP_NAME === 'ESP8266') {
        const [reply] = await this.sync();
        if (reply === 0) valid = true;
      } else {
        const res = await this.transport.read({ timeout: 1000, min_data: 6 });
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

    main_fn = async () => {
      await this.detect_chip();
      if (this.chip == null) {
        this.log('Error in connecting to board');
        return;
      }

      const chip = await this.chip.get_chip_description(this);
      this.log(`Chip is ${chip}`);
      this.log(`Features: ${await this.chip.get_chip_features(this)}`);
      this.log(`Crystal is ${await this.chip.get_crystal_freq(this)}MHz`);
      this.log(`MAC: ${await this.chip.read_mac(this)}`);
      await this.chip.read_mac(this);

      if (this.chip.IS_STUB) await this.run_stub();
      else this.FLASH_WRITE_SIZE = this.chip.FLASH_WRITE_SIZE || 0x4000;
    }

    flash_size_bytes = (flash_size) => {
      let flash_size_b = -1;
      if (flash_size.indexOf('KB') !== -1) {
        flash_size_b = parseInt(flash_size.slice(0, flash_size.indexOf('KB')), 10) * 1024;
      } else if (flash_size.indexOf('MB') !== -1) {
        flash_size_b = parseInt(flash_size.slice(0, flash_size.indexOf('MB')), 10) * 1024 * 1024;
      }
      return flash_size_b;
    }

    pad_array = (arr, len, fillValue) => Object.assign(new Array(len).fill(fillValue), arr)

    parse_flash_size_arg = (flsz) => {
      if (typeof this.chip.FLASH_SIZES[flsz] === 'undefined') {
        this.log(`Flash size ${flsz} is not supported by this chip type. Supported sizes: ${this.chip.FLASH_SIZES}`);
        throw 'Invalid flash size';
      }
      return this.chip.FLASH_SIZES[flsz];
    }

    _update_image_flash_params = (image, address, flash_size, flash_mode, flash_freq) => {
      // console.log(`_update_image_flash_params ${flash_size} ${flash_mode} ${flash_freq}`);
      if (image.length < 8) {
        return image;
      }
      if (address !== this.chip.BOOTLOADER_FLASH_OFFSET) {
        return image;
      }
      if (flash_size === 'keep' && flash_mode === 'keep' && flash_freq === 'keep') {
        // console.log('Not changing the image');
        return image;
      }

      const magic = image[0];
      let a_flash_mode = image[2];
      const flash_size_freq = image[3];
      if (magic !== this.ESP_IMAGE_MAGIC) {
        this.log(`Warning: Image file at 0x${
          address.toString(16)
        } doesn't look like an image file, so not changing any flash settings.`);
        return image;
      }

      /* XXX: Yet to implement actual image verification */

      if (flash_mode !== 'keep') {
        const flash_modes = {
          qio: 0, qout: 1, dio: 2, dout: 3,
        };
        a_flash_mode = flash_modes[flash_mode];
      }
      let a_flash_freq = flash_size_freq & 0x0F;
      if (flash_freq !== 'keep') {
        const flash_freqs = {
          '40m': 0, '26m': 1, '20m': 2, '80m': 0xf,
        };
        a_flash_freq = flash_freqs[flash_freq];
      }
      let a_flash_size = flash_size_freq & 0xF0;
      if (flash_size !== 'keep') {
        a_flash_size = this.parse_flash_size_arg(flash_size);
      }

      const flash_params = (a_flash_mode << 8) | (a_flash_freq + a_flash_size);
      this.log(`Flash params set to ${flash_params.toString(16)}`);
      if (image[2] !== (a_flash_mode << 8)) {
        // eslint-disable-next-line no-param-reassign
        image[2] = (a_flash_mode << 8);
      }
      if (image[3] !== (a_flash_freq + a_flash_size)) {
        // eslint-disable-next-line no-param-reassign
        image[3] = (a_flash_freq + a_flash_size);
      }
      return image;
    }

    write_flash = async ({
      fileArray = [], flash_size = 'keep', flash_mode = 'keep', flash_freq = 'keep', erase_all = false, compress = true,
    } = {}) => {
      // console.log('EspLoader program');
      if (flash_size !== 'keep') {
        const flash_end = this.flash_size_bytes(flash_size);
        for (let i = 0; i < fileArray.length; i++) {
          if ((fileArray[i].data.length + fileArray[i].address) > flash_end) {
            this.log("Specified file doesn't fit in the available flash");
            return;
          }
        }
      }

      if (this.IS_STUB === true && erase_all === true) {
        this.erase_flash();
      }
      let image;
      let address;
      for (let i = 0; i < fileArray.length; i++) {
        // console.log(`Data Length ${fileArray[i].data.length}`);
        // image = this.pad_array(fileArray[i].data, Math.floor((fileArray[i].data.length + 3)/4) * 4, 0xff);
        // XXX : handle padding
        image = fileArray[i].data;
        address = fileArray[i].address;
        // console.log(`Image Length ${image.length}`);
        if (image.length === 0) {
          this.log('Warning: File is empty');
          // eslint-disable-next-line no-continue
          continue;
        }
        image = this._update_image_flash_params(image, address, flash_size, flash_mode, flash_freq);
        const calcmd5 = CryptoJS.MD5(CryptoJS.enc.Base64.parse(image.toString('base64')));
        // console.log(`Image MD5 ${calcmd5}`);
        const uncsize = image.length;
        let blocks;
        // console.log(image);
        if (compress) {
          // const uncimage = this.bstrToUi8(image);
          image = pako.deflate(image, { level: 9 });
          // console.log('Compressed image ');
          // console.log(image);
          blocks = await this.flash_defl_begin(uncsize, image.length, address);
        } else {
          blocks = await this.flash_begin(uncsize, address);
        }
        let seq = 0;
        let bytes_sent = 0;
        // const bytes_written = 0;

        let d = new Date();
        const t1 = d.getTime();

        let timeout = 5000;
        while (image.length > 0) {
          // console.log(`Write loop ${address} ${seq} ${blocks}`);
          this.write_char(`\rWriting at 0x${
            (address + (seq * this.FLASH_WRITE_SIZE)).toString(16)
          }... (${
            Math.floor(100 * ((seq + 1) / blocks))
          }%)`);
          let block = image.slice(0, this.FLASH_WRITE_SIZE);
          if (compress) {
            /*
                    let block_uncompressed = pako.inflate(block).length;
                    //let len_uncompressed = block_uncompressed.length;
                    bytes_written += block_uncompressed;
                    if (this.timeout_per_mb(this.ERASE_WRITE_TIMEOUT_PER_MB, block_uncompressed) > 3000) {
                        block_timeout = this.timeout_per_mb(this.ERASE_WRITE_TIMEOUT_PER_MB, block_uncompressed);
                    } else {
                        block_timeout = 3000;
                    } */ // XXX: Partial block inflate seems to be unsupported in Pako. Hardcoding timeout
            const block_timeout = 5000;
            if (this.IS_STUB === false) {
              timeout = block_timeout;
            }
            await this.flash_defl_block(block, seq, timeout);
            if (this.IS_STUB) {
              timeout = block_timeout;
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
            //     esp.flash_block(block, seq)
            // bytes_written += len(block)
            await this.flash_block(block, seq, timeout);
          }
          bytes_sent += block.length;
          image = image.slice(this.FLASH_WRITE_SIZE, image.length);
          seq++;
        }
        if (this.IS_STUB) {
          await this.read_reg({ addr: this.CHIP_DETECT_MAGIC_REG_ADDR, timeout });
        }
        d = new Date();
        const t = d.getTime() - t1;
        this.log('');
        this.log(`Wrote ${uncsize} bytes${
          compress ? ` (${bytes_sent} compressed)` : ''
        } at 0x${address.toString(16)} in ${t / 1000} seconds.`);
        this._sleep(100);
        if (this.IS_STUB || this.chip.CHIP_NAME !== 'ESP8266') {
          const res = await this.flash_md5sum(address, uncsize);
          if (`${res}` !== `${calcmd5}`) {
            this.log(`File  md5: ${calcmd5}`);
            this.log(`Flash md5: ${res}`);
          } else {
            this.log('Hash of data verified.');
          }
        }
      }
      this.log('Leaving...');

      if (this.IS_STUB) {
        await this.flash_begin(0, 0);
        if (compress) {
          await this.flash_defl_finish();
        } else {
          await this.flash_finish();
        }
      }
    }

    flash_id = async () => {
      // console.log('flash_id');
      const flashid = await this.read_flash_id();
      this.log(`Manufacturer: ${(flashid & 0xff).toString(16)}`);
      const flid_lowbyte = (flashid >> 16) & 0xff;
      this.log(`Device: ${((flashid >> 8) & 0xff).toString(16)}${flid_lowbyte.toString(16)}`);
      this.log(`Detected flash size: ${this.DETECTED_FLASH_SIZES[flid_lowbyte] || 'Unknown'}`);
    }
}
