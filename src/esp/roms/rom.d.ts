import ESPLoader from '../ESPLoader';

interface flashSizes {
  [key: string]: number;
}

export default interface ROM {
  CHIP_NAME: string;
  IS_STUB: boolean;
  FLASH_SIZES: flashSizes;
  IMAGE_CHIP_ID?: number;
  CHIP_DETECT_MAGIC_VALUE: number;
  EFUSE_BASE?: number;
  MAC_EFUSE_REG?: number;
  EFUSE_RD_REG_BASE?: number;
  DR_REG_SYSCON_BASE?: number;
  UART_CLKDIV_REG: number;
  UART_CLKDIV_MASK?: number;
  UART_DATE_REG_ADDR: number;
  XTAL_CLK_DIVIDER?: number;
  FLASH_WRITE_SIZE: number;
  BOOTLOADER_FLASH_OFFSET: number;
  SPI_REG_BASE?: number;
  SPI_USR_OFFS: number;
  SPI_USR1_OFFS: number;
  SPI_USR2_OFFS: number;
  SPI_W0_OFFS: number;
  SPI_MOSI_DLEN_OFFS: number | null;
  SPI_MISO_DLEN_OFFS: number | null;
  ESP_OTP_MAC?: [number, number, number, number];

  readEfuse?: (loader: ESPLoader, offset: number) => Promise<number>;
  getPkgVersion?: (loader: ESPLoader) => Promise<number>;
  getChipRevision?: (loader: ESPLoader) => Promise<number>;
  getChipDescription: (loader: ESPLoader) => Promise<string>;
  getChipFeatures: (loader: ESPLoader) => Promise<string[]>;
  getCrystalFreq: (loader: ESPLoader) => Promise<number>;
  readMac: (loader: ESPLoader) => Promise<string>;
  getEraseSize: (offset: number, size: number) => number;
  getEfuses?: (loader: ESPLoader) => Promise<number>;
  getFlashSize?: (efuses: number) => number;
}
