import ESPLoader from '../ESPLoader';

interface flashSizes {
  [key: string]: number;
}

export default class ESP8266ROM {
  static CHIP_NAME = 'ESP8266';

  static IS_STUB = true;

  static CHIP_DETECT_MAGIC_VALUE = 0xfff0c101;

  static FLASH_WRITE_SIZE = 0x400;

  // OTP ROM addresses
  static ESP_OTP_MAC0 = 0x3ff00050

  static ESP_OTP_MAC1 = 0x3ff00054

  static ESP_OTP_MAC3 = 0x3ff0005c

  static SPI_REG_BASE = 0x60000200

  static SPI_USR_OFFS = 0x1c

  static SPI_USR1_OFFS = 0x20

  static SPI_USR2_OFFS = 0x24

  static SPI_MOSI_DLEN_OFFS = null

  static SPI_MISO_DLEN_OFFS = null

  static SPI_W0_OFFS = 0x40

  static UART_CLKDIV_REG = 0x60000014

  static XTAL_CLK_DIVIDER = 2

  static FLASH_SIZES = {
    '512KB': 0x00,
    '256KB': 0x10,
    '1MB': 0x20,
    '2MB': 0x30,
    '4MB': 0x40,
    '2MB-c1': 0x50,
    '4MB-c1': 0x60,
    '8MB': 0x80,
    '16MB': 0x90,
  } as flashSizes

  static BOOTLOADER_FLASH_OFFSET = 0

  static UART_DATE_REG_ADDR = 0

  static MEMORY_MAP = [[0x3FF00000, 0x3FF00010, 'DPORT'],
    [0x3FFE8000, 0x40000000, 'DRAM'],
    [0x40100000, 0x40108000, 'IRAM'],
    [0x40201010, 0x402E1010, 'IROM']]

  static async getEfuses(loader: ESPLoader) {
    // Return the 128 bits of ESP8266 efuse as a single integer
    const result = (await loader.readReg(0x3ff0005c) << 96)
      | (await loader.readReg(0x3ff00058) << 64)
      | (await loader.readReg(0x3ff00054) << 32)
      | await loader.readReg(0x3ff00050);
    return result;
  }

  static #getFlashSize(efuses: number) {
    // rX_Y = EFUSE_DATA_OUTX[Y]
    const r0_4 = (efuses & (1 << 4)) !== 0;
    const r3_25 = (efuses & (1 << 121)) !== 0;
    const r3_26 = (efuses & (1 << 122)) !== 0;
    const r3_27 = (efuses & (1 << 123)) !== 0;

    if (r0_4 && !r3_25) {
      if (!r3_27 && !r3_26) {
        return 1;
      } if (!r3_27 && r3_26) {
        return 2;
      }
    }
    if (!r0_4 && r3_25) {
      if (!r3_27 && !r3_26) {
        return 2;
      } if (!r3_27 && r3_26) {
        return 4;
      }
    }
    return -1;
  }

  static async getChipDescription(loader: ESPLoader) {
    const efuses = await this.getEfuses(loader);
    const is8285 = (efuses & (((1 << 4) | 1) << 80)) !== 0; // One or the other efuse bit is set for ESP8285
    if (is8285) {
      const flashSize = this.#getFlashSize(efuses);
      const maxTemp = (efuses & (1 << 5)) !== 0; // This efuse bit identifies the max flash temperature
      let chipName = 'ESP8285';
      if (flashSize === 1) chipName = maxTemp ? 'ESP8285H08' : 'ESP8285N08';
      if (flashSize === 2) chipName = maxTemp ? 'ESP8285H16' : 'ESP8285N16';
      return chipName;
    }
    return 'ESP8266EX';
  }

  static async getChipFeatures(loader: ESPLoader) {
    const features = ['WiFi'];
    if (await this.getChipDescription(loader) === 'ESP8285') {
      features.push('Embedded Flash');
    }
    return features;
  }

  // static flash_spi_attach = async (loader, hspi_arg) => {
  //   if (this.IS_STUB) {
  //     await super.flash_spi_attach(loader, hspi_arg);
  //   } else {
  //     // ESP8266 ROM has no flash_spi_attach command in serial protocol,
  //     // but flash_begin will do it
  //     await loader.flash_begin(0, 0);
  //   }
  // }

  // static flash_set_parameters = async (loader, size) => {
  //   // not implemented in ROM, but OK to silently skip for ROM
  //   if (this.IS_STUB) {
  //     await super.flash_set_parameters(loader, size);
  //   }
  // }

  static async chipId(loader: ESPLoader) {
    // Read Chip ID from efuse - the equivalent of the SDK system_get_chip_id() function
    const id0 = await loader.readReg(this.ESP_OTP_MAC0);
    const id1 = await loader.readReg(this.ESP_OTP_MAC1);
    return (id0 >> 24) | ((id1 & 0xffffff) << 8);
  }

  static async readMac(loader: ESPLoader) {
    // Read MAC from OTP ROM
    const mac0 = await loader.readReg(this.ESP_OTP_MAC0);
    const mac1 = await loader.readReg(this.ESP_OTP_MAC1);
    const mac3 = await loader.readReg(this.ESP_OTP_MAC3);
    let oui;
    if (mac3 !== 0) {
      oui = [(mac3 >> 16) & 0xff, (mac3 >> 8) & 0xff, mac3 & 0xff];
    } else if (((mac1 >> 16) & 0xff) === 0) {
      oui = [0x18, 0xfe, 0x34];
    } else if (((mac1 >> 16) & 0xff) === 1) {
      oui = [0xac, 0xd0, 0x74];
    } else {
      throw new Error('Unknown OUI');
    }
    return [...oui, (mac1 >> 8) & 0xff, mac1 & 0xff, (mac0 >> 24) & 0xff];
  }

  static getEraseSize(offset: number, size: number) { return size; }

  // eslint-disable-next-line no-unused-vars
  static async getCrystalFreq(loader: ESPLoader) { return 40; }
}