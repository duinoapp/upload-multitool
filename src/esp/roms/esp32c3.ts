import ESPLoader from '../loader';
import ROM from './rom';
import { toMac } from './util';

const EFUSE_BASE = 0x60008800;

export default {
  CHIP_NAME: 'ESP32-C3',
  IS_STUB: true,
  SUPPORTS_ENCRYPTION: true,
  IMAGE_CHIP_ID: 5,
  CHIP_DETECT_MAGIC_VALUE: 0x6921506f,
  EFUSE_BASE,
  MAC_EFUSE_REG: EFUSE_BASE + 0x044,
  UART_CLKDIV_REG: 0x3ff40014,
  UART_CLKDIV_MASK: 0xFFFFF,
  UART_DATE_REG_ADDR: 0x6000007C,
  FLASH_WRITE_SIZE: 0x400,
  BOOTLOADER_FLASH_OFFSET: 0x1000,
  SPI_REG_BASE: 0x60002000,
  SPI_USR_OFFS: 0x18,
  SPI_USR1_OFFS: 0x1C,
  SPI_USR2_OFFS: 0x20,
  SPI_MOSI_DLEN_OFFS: 0x24,
  SPI_MISO_DLEN_OFFS: 0x28,
  SPI_W0_OFFS: 0x58,

  FLASH_SIZES: {
    '1MB': 0x00, '2MB': 0x10, '4MB': 0x20, '8MB': 0x30, '16MB': 0x40,
  },

  async getPkgVersion(loader: ESPLoader) {
    const numWord = 3;
    const block1Addr = EFUSE_BASE + 0x044;
    const addr = block1Addr + (4 * numWord);
    const word3 = await loader.readReg(addr);
    const pkgVersion = (word3 >> 21) & 0x0F;
    return pkgVersion;
  },

  async getChipRevision(loader: ESPLoader) {
    const block1Addr = EFUSE_BASE + 0x044;
    const numWord = 3;
    const pos = 18;
    const addr = block1Addr + (4 * numWord);
    const ret = (await loader.readReg(addr) & (0x7 << pos)) >> pos;
    return ret;
  },

  async getChipDescription(loader: ESPLoader) {
    if (!this.getChipRevision) throw new Error('getChipRevision not implemented');
    if (!this.getPkgVersion) throw new Error('getPkgVersion not implemented');
    let desc;
    const pkgVer = await this.getPkgVersion(loader);
    if (pkgVer === 0) {
      desc = 'ESP32-C3';
    } else {
      desc = 'unknown ESP32-C3';
    }
    const chip_rev = await this.getChipRevision(loader);
    desc += ` (revision ${chip_rev})`;
    return desc;
  },

  // eslint-disable-next-line no-unused-vars
  async getChipFeatures(loader: ESPLoader) { return ['Wi-Fi']; },

  // eslint-disable-next-line no-unused-vars
  async getCrystalFreq(loader: ESPLoader) { return 40; },

  async readMac(loader: ESPLoader) {
    if (!this.MAC_EFUSE_REG) return '';
    let mac0 = await loader.readReg(this.MAC_EFUSE_REG);
    mac0 >>>= 0;
    let mac1 = await loader.readReg(this.MAC_EFUSE_REG + 4);
    mac1 = (mac1 >>> 0) & 0x0000ffff;
    return toMac(mac0, mac1);
  },

  getEraseSize(offset: number, size: number) { return size; },
} as ROM;
