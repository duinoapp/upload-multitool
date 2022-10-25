import { SerialPort } from 'serialport/dist/index.d';
import { ProgramConfig } from '../index.d';
import ESPLoader, { ESPOptions, UploadFileDef } from './ESPLoader';
import asyncTimeout from '../util/asyncTimeout';

const isSupported = (cpu: string) => ['esp8266', 'esp32'].includes(cpu);

export const upload = async (serial: SerialPort, config: ProgramConfig) => {
  if (!config.files?.length) throw new Error('No files to upload');
  // const log = (...args) => config.debug(`${args.join(' ')}\r\n`);
  const log = (...args: any[]) => console.log(...args);
  // const term = { log, debug: log, write: config.debug };

  // serial.on('data', (data: Buffer) => {
  //   console.log('read (utf8)', data.toString('utf-8'));
  //   console.log('read (hex)', data.toString('hex'));
  // });

  let espLoader;
  try {
    espLoader = new ESPLoader(serial, {
      quiet: !config.verbose,
    } as ESPOptions);
    await espLoader.mainFn();
    // await espLoader.flash_id();
    log('> Connected');

    if (config.uploadSpeed) {
      await espLoader.changeBaudrate(config.uploadSpeed);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    try {
      await serial.close();
    } catch (err2) {
      // eslint-disable-next-line no-console
      console.error(err2);
    }
    return;
  }

  try {
    log('> Writing main data partition, this may take a while...');
    await espLoader.writeFlash({
      fileArray: config.files.map((file) => ({ ...file, data: Buffer.from(file.data, 'base64') })),
      flashSize: '4MB',
      flashFreq: config.flashFreq || 'keep',
      flashMode: config.flashMode || 'keep',
      // compress: board.props?.build?.mcu !== 'esp8266',
    });
    await espLoader.reboot();
    await asyncTimeout(100);
    if (config.uploadSpeed) {
      await serial.update({ baudRate: config.speed || 115200 });
    }
    log('> Successfully written data partition');
    log('> Flashing succeeded! Have a nice day! :)');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    log('Failed to upload:', err instanceof Error ? err.message : err);
  }

};

export default { upload, isSupported };