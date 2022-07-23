export default class ESP32C3ROM {
  static CHIP_NAME = 'ESP32-C3';

  static IS_STUB = true;

  static IMAGE_CHIP_ID = 5;

  static CHIP_DETECT_MAGIC_VALUE = 0x6921506f;

  static EFUSE_BASE = 0x60008800;

  static MAC_EFUSE_REG = this.EFUSE_BASE + 0x044;

  static UART_CLKDIV_REG = 0x3ff40014;

  static UART_CLKDIV_MASK = 0xFFFFF;

  static UART_DATE_REG_ADDR = 0x6000007C;

  static FLASH_WRITE_SIZE = 0x400;

  static BOOTLOADER_FLASH_OFFSET = 0x1000;

  static FLASH_SIZES = {
    '1MB': 0x00, '2MB': 0x10, '4MB': 0x20, '8MB': 0x30, '16MB': 0x40,
  };

  static SPI_REG_BASE = 0x60002000;

  static SPI_USR_OFFS = 0x18;

  static SPI_USR1_OFFS = 0x1C;

  static SPI_USR2_OFFS = 0x20;

  static SPI_MOSI_DLEN_OFFS = 0x24;

  static SPI_MISO_DLEN_OFFS = 0x28;

  static SPI_W0_OFFS = 0x58;

  static get_pkg_version = async (loader) => {
    const num_word = 3;
    const block1_addr = this.EFUSE_BASE + 0x044;
    const addr = block1_addr + (4 * num_word);
    const word3 = await loader.read_reg({ addr });
    const pkg_version = (word3 >> 21) & 0x0F;
    return pkg_version;
  }

  static get_chip_revision = async (loader) => {
    const block1_addr = this.EFUSE_BASE + 0x044;
    const num_word = 3;
    const pos = 18;
    const addr = block1_addr + (4 * num_word);
    const ret = (await loader.read_reg({ addr }) & (0x7 << pos)) >> pos;
    return ret;
  }

  static get_chip_description = async (loader) => {
    let desc;
    const pkg_ver = await this.get_pkg_version(loader);
    if (pkg_ver === 0) {
      desc = 'ESP32-C3';
    } else {
      desc = 'unknown ESP32-C3';
    }
    const chip_rev = await this.get_chip_revision(loader);
    desc += ` (revision ${chip_rev})`;
    return desc;
  }

  // eslint-disable-next-line no-unused-vars
  static get_chip_features = async (loader) => ['Wi-Fi']

  // eslint-disable-next-line no-unused-vars
  static get_crystal_freq = async (loader) => 40

  static _d2h(d) {
    const h = (+d).toString(16);
    return h.length === 1 ? `0${h}` : h;
  }

  static read_mac = async (loader) => {
    let mac0 = await loader.read_reg({ addr: this.MAC_EFUSE_REG });
    mac0 >>>= 0;
    let mac1 = await loader.read_reg({ addr: this.MAC_EFUSE_REG + 4 });
    mac1 = (mac1 >>> 0) & 0x0000ffff;
    const mac = new Uint8Array(6);
    mac[0] = (mac1 >> 8) & 0xff;
    mac[1] = mac1 & 0xff;
    mac[2] = (mac0 >> 24) & 0xff;
    mac[3] = (mac0 >> 16) & 0xff;
    mac[4] = (mac0 >> 8) & 0xff;
    mac[5] = mac0 & 0xff;

    return (`${
      this._d2h(mac[0])
    }:${
      this._d2h(mac[1])
    }:${
      this._d2h(mac[2])
    }:${
      this._d2h(mac[3])
    }:${
      this._d2h(mac[4])
    }:${
      this._d2h(mac[5])
    }`);
  }

  static get_erase_size = (offset, size) => size
}