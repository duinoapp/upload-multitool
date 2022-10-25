import ESPLoader from '../loader';
import ROM from './rom';
import { toMac } from './util';

export default {
  CHIP_NAME: 'ESP32-S2',
  IS_STUB: true,
  SUPPORTS_ENCRYPTION: true,
  IMAGE_CHIP_ID: 2,
  CHIP_DETECT_MAGIC_VALUE: 0x000007c6,
  MAC_EFUSE_REG: 0x3f41A044,
  EFUSE_BASE: 0x3f41A000,
  UART_CLKDIV_REG: 0x3f400014,
  UART_CLKDIV_MASK: 0xFFFFF,
  UART_DATE_REG_ADDR: 0x60000078,
  FLASH_WRITE_SIZE: 0x400,
  BOOTLOADER_FLASH_OFFSET: 0x1000,
  SPI_REG_BASE: 0x3f402000,
  SPI_USR_OFFS: 0x18,
  SPI_USR1_OFFS: 0x1c,
  SPI_USR2_OFFS: 0x20,
  SPI_W0_OFFS: 0x58,
  SPI_MOSI_DLEN_OFFS: 0x24,
  SPI_MISO_DLEN_OFFS: 0x28,
  FLASH_SIZES: {
    '1MB': 0x00, '2MB': 0x10, '4MB': 0x20, '8MB': 0x30, '16MB': 0x40,
  },

  async getPkgVersion(loader: ESPLoader) {
    if (!this.EFUSE_BASE) throw new Error('EFUSE_BASE not implemented');
    const numWord = 3;
    const block1Addr = this.EFUSE_BASE + 0x044;
    const addr = block1Addr + (4 * numWord);
    const word3 = await loader.readReg(addr);
    const pkgVersion = (word3 >> 21) & 0x0F;
    return pkgVersion;
  },

  async getChipDescription(loader: ESPLoader) {
    if (!this.getPkgVersion) throw new Error('getPkgVersion not implemented');
    const chipDesc = ['ESP32-S2', 'ESP32-S2FH16', 'ESP32-S2FH32'];
    const pkgVer = await this.getPkgVersion(loader);
    if (pkgVer >= 0 && pkgVer <= 2) {
      return chipDesc[pkgVer];
    }
    return 'unknown ESP32-S2';
  },

  async getChipFeatures(loader: ESPLoader) {
    if (!this.EFUSE_BASE) throw new Error('EFUSE_BASE not implemented');
    if (!this.getPkgVersion) throw new Error('getPkgVersion not implemented');
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
  },

  // eslint-disable-next-line no-unused-vars
  async getCrystalFreq(loader: ESPLoader) { return 40; },

  async readMac(loader: ESPLoader) {
    if (!this.MAC_EFUSE_REG) throw new Error('MAC_EFUSE_REG not implemented');
    let mac0 = await loader.readReg(this.MAC_EFUSE_REG);
    mac0 >>>= 0;
    let mac1 = await loader.readReg(this.MAC_EFUSE_REG + 4);
    mac1 = (mac1 >>> 0) & 0x0000ffff;
    return toMac(mac0, mac1);
  },

  getEraseSize(offset: number, size: number) { return size; },
} as ROM;
