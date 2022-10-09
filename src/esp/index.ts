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

  // const { port } = serial;
  // const transport = new Transport(port, term);
  let espLoader;

  try {
    log('> Connecting...');
    espLoader = new ESPLoader(serial, {
      quiet: !config.verbose,
    } as ESPOptions);
    await espLoader.mainFn();
    // await espLoader.flash_id();
    log('> Connected');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    // log('Failed to connect:', typeof err === 'string' ? err : err.message);
    try {
      await serial.close();
    } catch (err2) {
      // eslint-disable-next-line no-console
      console.error(err2);
    }
    return;
  }

  try {
    // if (board.config?.wipe && board.config.wipe !== 'none') {
    //   log('> Erasing device flash...');
    //   await espLoader.erase_flash();
    //   log('> Successfully erased device flash');
    // }
    log('> Writing main data partition, this may take a while...');
    await espLoader.writeFlash({
      fileArray: config.files.map((file) => ({ ...file, data: Buffer.from(file.data, 'base64') })),
      flashSize: 'keep',
      // flash_freq,
      // flash_mode,
      // compress: board.props?.build?.mcu !== 'esp8266',
    });
    await espLoader.flashDeflFinish({ reboot: true });
    await asyncTimeout(100);
    log('> Successfully written data partition');
    log('> Flashing succeeded! Have a nice day! :)');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    log('Failed to upload:', err instanceof Error ? err.message : err);
  }

  // try {
  //   await serial.close();
  // } catch (err) {
  //   // eslint-disable-next-line no-console
  //   console.error(err);
  // }
};

export default { upload, isSupported };