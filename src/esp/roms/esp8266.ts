import ESPLoader from '../loader';
import ROM from './rom';
import { toHex } from './util';

export default {
  CHIP_NAME: 'ESP8266',
  IS_STUB: true,
  CHIP_DETECT_MAGIC_VALUE: 0xfff0c101,
  FLASH_WRITE_SIZE: 0x400,
  // OTP ROM addresses
  ESP_OTP_MAC: [
    0x3ff00050,
    0x3ff00054,
    0x3ff0005c,
    0x60000200,
  ],
  SPI_USR_OFFS: 0x1c,
  SPI_USR1_OFFS: 0x20,
  SPI_USR2_OFFS: 0x24,
  SPI_MOSI_DLEN_OFFS: null,
  SPI_MISO_DLEN_OFFS: null,
  SPI_W0_OFFS: 0x40,
  UART_CLKDIV_REG: 0x60000014,
  XTAL_CLK_DIVIDER: 2,
  BOOTLOADER_FLASH_OFFSET: 0,
  UART_DATE_REG_ADDR: 0,
  FLASH_SIZES: {
    '512KB': 0x00,
    '256KB': 0x10,
    '1MB': 0x20,
    '2MB': 0x30,
    '4MB': 0x40,
    '2MB-c1': 0x50,
    '4MB-c1': 0x60,
    '8MB': 0x80,
    '16MB': 0x90,
  },

  MEMORY_MAP: [
    [0x3FF00000, 0x3FF00010, 'DPORT'],
    [0x3FFE8000, 0x40000000, 'DRAM'],
    [0x40100000, 0x40108000, 'IRAM'],
    [0x40201010, 0x402E1010, 'IROM'],
  ],

  async getEfuses(loader: ESPLoader) {
    // Return the 128 bits of ESP8266 efuse as a single integer
    const result = (await loader.readReg(0x3ff0005c) << 96)
      | (await loader.readReg(0x3ff00058) << 64)
      | (await loader.readReg(0x3ff00054) << 32)
      | await loader.readReg(0x3ff00050);
    return result;
  },

  getFlashSize(efuses: number) {
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
  },

  async getChipDescription(loader: ESPLoader) {
    if (!this.getEfuses) throw new Error('getEfuses not implemented');
    if (!this.getFlashSize) throw new Error('getFlashSize not implemented');
    const efuses = await this.getEfuses(loader);
    const is8285 = (efuses & (((1 << 4) | 1) << 80)) !== 0; // One or the other efuse bit is set for ESP8285
    if (is8285) {
      const flashSize = this.getFlashSize(efuses);
      const maxTemp = (efuses & (1 << 5)) !== 0; // This efuse bit identifies the max flash temperature
      let chipName = 'ESP8285';
      if (flashSize === 1) chipName = maxTemp ? 'ESP8285H08' : 'ESP8285N08';
      if (flashSize === 2) chipName = maxTemp ? 'ESP8285H16' : 'ESP8285N16';
      return chipName;
    }
    return 'ESP8266EX';
  },

  async getChipFeatures(loader: ESPLoader) {
    const features = ['WiFi'];
    if (await this.getChipDescription(loader) === 'ESP8285') {
      features.push('Embedded Flash');
    }
    return features;
  },

  async chipId(loader: ESPLoader) {
    if (!this.ESP_OTP_MAC) throw new Error('ESP_OTP_MAC not implemented');
    // Read Chip ID from efuse - the equivalent of the SDK system_get_chip_id() function
    const id0 = await loader.readReg(this.ESP_OTP_MAC[0]);
    const id1 = await loader.readReg(this.ESP_OTP_MAC[1]);
    return (id0 >> 24) | ((id1 & 0xffffff) << 8);
  },

  async readMac(loader: ESPLoader) {
    if (!this.ESP_OTP_MAC) throw new Error('ESP_OTP_MAC not implemented');
    // Read MAC from OTP ROM
    const mac0 = await loader.readReg(this.ESP_OTP_MAC[0]);
    const mac1 = await loader.readReg(this.ESP_OTP_MAC[1]);
    const mac3 = await loader.readReg(this.ESP_OTP_MAC[3]);
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
    return [...oui, (mac1 >> 8) & 0xff, mac1 & 0xff, (mac0 >> 24) & 0xff]
      .map(toHex).join(':');
  },

  getEraseSize(offset: number, size: number) { return size; },

  // eslint-disable-next-line no-unused-vars
  async getCrystalFreq(loader: ESPLoader) { return 40; },
} as ROM;