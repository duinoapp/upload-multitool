export default class ESP32ROM {
  static CHIP_NAME = 'ESP32';

  static IS_STUB = true;

  static IMAGE_CHIP_ID = 0;

  static CHIP_DETECT_MAGIC_VALUE = 0x00f01d83;

  static EFUSE_RD_REG_BASE = 0x3ff5a000;

  static DR_REG_SYSCON_BASE = 0x3ff66000;

  static UART_CLKDIV_REG = 0x3ff40014;

  static UART_CLKDIV_MASK = 0xFFFFF;

  static UART_DATE_REG_ADDR = 0x60000078;

  static XTAL_CLK_DIVIDER= 1;

  static FLASH_WRITE_SIZE = 0x400;

  static BOOTLOADER_FLASH_OFFSET = 0x1000;

  static FLASH_SIZES = {
    '1MB': 0x00, '2MB': 0x10, '4MB': 0x20, '8MB': 0x30, '16MB': 0x40,
  };

  static SPI_REG_BASE = 0x3ff42000;

  static SPI_USR_OFFS = 0x1c;

  static SPI_USR1_OFFS = 0x20;

  static SPI_USR2_OFFS = 0x24;

  static SPI_W0_OFFS = 0x80;

  static SPI_MOSI_DLEN_OFFS = 0x28;

  static SPI_MISO_DLEN_OFFS = 0x2c;

  static read_efuse = async (loader, offset) => {
    const addr = this.EFUSE_RD_REG_BASE + (4 * offset);
    // console.log(`Read efuse ${addr}`);
    return loader.read_reg({ addr });
  }

  static get_pkg_version = async (loader) => {
    const word3 = await this.read_efuse(loader, 3);
    let pkg_version = (word3 >> 9) & 0x07;
    pkg_version += ((word3 >> 2) & 0x1) << 3;
    return pkg_version;
  }

  static get_chip_revision = async (loader) => {
    const word3 = await this.read_efuse(loader, 3);
    const word5 = await this.read_efuse(loader, 5);
    const apb_ctl_date = await loader.read_reg({ addr: this.DR_REG_SYSCON_BASE + 0x7C });

    const rev_bit0 = (word3 >> 15) & 0x1;
    const rev_bit1 = (word5 >> 20) & 0x1;
    const rev_bit2 = (apb_ctl_date >> 31) & 0x1;
    if (rev_bit0 !== 0) {
      if (rev_bit1 !== 0) {
        if (rev_bit2 !== 0) {
          return 3;
        }
        return 2;
      }
      return 1;
    }
    return 0;
  }

  static get_chip_description = async (loader) => {
    const chip_desc = ['ESP32-D0WDQ6', 'ESP32-D0WD', 'ESP32-D2WD', '', 'ESP32-U4WDH', 'ESP32-PICO-D4', 'ESP32-PICO-V3-02'];
    let chip_name = '';
    const pkg_version = await this.get_pkg_version(loader);
    const chip_revision = await this.get_chip_revision(loader);
    const rev3 = (chip_revision === 3);
    const single_core = await this.read_efuse(loader, 3) & (1 << 0);

    if (single_core !== 0) {
      chip_desc[0] = 'ESP32-S0WDQ6';
      chip_desc[1] = 'ESP32-S0WD';
    }
    if (rev3) {
      chip_desc[5] = 'ESP32-PICO-V3';
    }
    if (pkg_version >= 0 && pkg_version <= 6) {
      chip_name = chip_desc[pkg_version];
    } else {
      chip_name = 'Unknown ESP32';
    }

    if (rev3 && (pkg_version === 0 || pkg_version === 1)) {
      chip_name += '-V3';
    }
    return `${chip_name} (revision ${chip_revision})`;
  }

  static get_chip_features = async (loader) => {
    const features = ['Wi-Fi'];
    const word3 = await this.read_efuse(loader, 3);

    const chip_ver_dis_bt = word3 & (1 << 1);
    if (chip_ver_dis_bt === 0) {
      features.push(' BT');
    }

    const chip_ver_dis_app_cpu = word3 & (1 << 0);
    if (chip_ver_dis_app_cpu !== 0) {
      features.push(' Single Core');
    } else {
      features.push(' Dual Core');
    }

    const chip_cpu_freq_rated = word3 & (1 << 13);
    if (chip_cpu_freq_rated !== 0) {
      const chip_cpu_freq_low = word3 & (1 << 12);
      if (chip_cpu_freq_low !== 0) {
        features.push(' 160MHz');
      } else {
        features.push(' 240MHz');
      }
    }

    const pkg_version = await this.get_pkg_version(loader);
    if ([2, 4, 5, 6].includes(pkg_version)) {
      features.push(' Embedded Flash');
    }

    if (pkg_version === 6) {
      features.push(' Embedded PSRAM');
    }

    const word4 = await this.read_efuse(loader, 4);
    const adc_vref = (word4 >> 8) & 0x1F;
    if (adc_vref !== 0) {
      features.push(' VRef calibration in efuse');
    }

    const blk3_part_res = (word3 >> 14) & 0x1;
    if (blk3_part_res !== 0) {
      features.push(' BLK3 partially reserved');
    }

    const word6 = await this.read_efuse(loader, 6);
    const coding_scheme = word6 & 0x3;
    const coding_scheme_arr = ['None', '3/4', 'Repeat (UNSUPPORTED)', 'Invalid'];
    features.push(` Coding Scheme ${coding_scheme_arr[coding_scheme]}`);

    return features;
  }

  static get_crystal_freq = async (loader) => {
    const uart_div = await loader.read_reg({ addr: this.UART_CLKDIV_REG }) & this.UART_CLKDIV_MASK;
    const ets_xtal = (loader.transport.baudrate * uart_div) / 1000000 / this.XTAL_CLK_DIVIDER;
    let norm_xtal;
    if (ets_xtal > 33) {
      norm_xtal = 40;
    } else {
      norm_xtal = 26;
    }
    if (Math.abs(norm_xtal - ets_xtal) > 1) {
      loader.log('WARNING: Unsupported crystal in use');
    }
    return norm_xtal;
  }

  static _d2h(d) {
    const h = (+d).toString(16);
    return h.length === 1 ? `0${h}` : h;
  }

  static read_mac = async (loader) => {
    let mac0 = await this.read_efuse(loader, 1);
    mac0 >>>= 0;
    let mac1 = await this.read_efuse(loader, 2);
    mac1 >>>= 0;
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