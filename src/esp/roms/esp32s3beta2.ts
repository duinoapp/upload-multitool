import ESPLoader from '../ESPLoader';

interface flashSizes {
  [key: string]: number;
}

export default class ESP32S3BETA2ROM {
  static CHIP_NAME = 'ESP32-S3';

  static IMAGE_CHIP_ID = 4;

  static CHIP_DETECT_MAGIC_VALUE = 0xeb004136;

  // eslint-disable-next-line no-unused-vars
  static async get_pkg_version(loader: ESPLoader) {
    throw new Error('Not implemented');
  }

  // eslint-disable-next-line no-unused-vars
  static async get_chip_revision(loader: ESPLoader) {
    throw new Error('Not implemented');
  }

  // eslint-disable-next-line no-unused-vars
  static async get_chip_description(loader: ESPLoader) {
    throw new Error('Not implemented');
  }

  // eslint-disable-next-line no-unused-vars
  static async get_chip_features(loader: ESPLoader) {
    throw new Error('Not implemented');
  }

  // eslint-disable-next-line no-unused-vars
  static async get_crystal_freq(loader: ESPLoader) {
    throw new Error('Not implemented');
  }

  // eslint-disable-next-line no-unused-vars
  static async read_mac(loader: ESPLoader) {
    throw new Error('Not implemented');
  }
}
