import ESPLoader from '../ESPLoader';

interface flashSizes {
  [key: string]: number;
}

export default class ESP32S2ROM {
  static CHIP_NAME = 'ESP32-S2';

  static IS_STUB = true;

  static IMAGE_CHIP_ID = 2;

  static CHIP_DETECT_MAGIC_VALUE = 0x000007c6;

  static MAC_EFUSE_REG = 0x3f41A044;

  static EFUSE_BASE = 0x3f41A000;

  static UART_CLKDIV_REG = 0x3f400014;

  static UART_CLKDIV_MASK = 0xFFFFF;

  static UART_DATE_REG_ADDR = 0x60000078;

  static FLASH_WRITE_SIZE = 0x400;

  static BOOTLOADER_FLASH_OFFSET = 0x1000;

  static FLASH_SIZES = {
    '1MB': 0x00, '2MB': 0x10, '4MB': 0x20, '8MB': 0x30, '16MB': 0x40,
  } as flashSizes;

  static SPI_REG_BASE = 0x3f402000;

  static SPI_USR_OFFS = 0x18;

  static SPI_USR1_OFFS = 0x1c;

  static SPI_USR2_OFFS = 0x20;

  static SPI_W0_OFFS = 0x58;

  static SPI_MOSI_DLEN_OFFS = 0x24;

  static SPI_MISO_DLEN_OFFS = 0x28;

  static async getPkgVersion(loader: ESPLoader) {
    const numWord = 3;
    const block1Addr = this.EFUSE_BASE + 0x044;
    const addr = block1Addr + (4 * numWord);
    const word3 = await loader.readReg(addr);
    const pkgVersion = (word3 >> 21) & 0x0F;
    return pkgVersion;
  }

  static async getChipDescription(loader: ESPLoader) {
    const chipDesc = ['ESP32-S2', 'ESP32-S2FH16', 'ESP32-S2FH32'];
    const pkgVer = await this.getPkgVersion(loader);
    if (pkgVer >= 0 && pkgVer <= 2) {
      return chipDesc[pkgVer];
    }
    return 'unknown ESP32-S2';
  }

  static async getChipFeatures(loader: ESPLoader) {
    const features = ['Wi-Fi'];
    const pkgVer = await this.getPkgVersion(loader);
    if (pkgVer === 1) {
      features.push('Embedded 2MB Flash');
    } else if (pkgVer === 2) {
      features.push('Embedded 4MB Flash');
    }
    const numWord = 4;
    const block2Addr = this.EFUSE_BASE + 0x05C;
    const addr = block2Addr + (4 * numWord);
    const word4 = await loader.readReg(addr);
    const block2Ver = (word4 >> 4) & 0x07;

    if (block2Ver === 1) {
      features.push('ADC and temperature sensor calibration in BLK2 of efuse');
    }
    return features;
  }

  // eslint-disable-next-line no-unused-vars
  static async getCrystalFreq(loader: ESPLoader) { return 40; }

  static #d2h(d: number) {
    const h = (Number(d)).toString(16);
    return h.length === 1 ? `0${h}` : h;
  }

  static readMac = async (loader: ESPLoader) => {
    let mac0 = await loader.readReg(this.MAC_EFUSE_REG);
    mac0 >>>= 0;
    let mac1 = await loader.readReg(this.MAC_EFUSE_REG + 4);
    mac1 = (mac1 >>> 0) & 0x0000ffff;
    const mac = new Uint8Array(6);
    mac[0] = (mac1 >> 8) & 0xff;
    mac[1] = mac1 & 0xff;
    mac[2] = (mac0 >> 24) & 0xff;
    mac[3] = (mac0 >> 16) & 0xff;
    mac[4] = (mac0 >> 8) & 0xff;
    mac[5] = mac0 & 0xff;

    return (`${
      this.#d2h(mac[0])
    }:${
      this.#d2h(mac[1])
    }:${
      this.#d2h(mac[2])
    }:${
      this.#d2h(mac[3])
    }:${
      this.#d2h(mac[4])
    }:${
      this.#d2h(mac[5])
    }`);
  }

  static getEraseSize = (offset: number, size: number) => size
}