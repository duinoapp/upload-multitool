import { SerialPort } from 'serialport/dist/index.d';

import { setBaud, waitForOpen } from './util/serial-helpers';
import { ReconnectParams } from './avr/avr109/avr109';
import avr from './avr/index';
import esp from './esp/index';

export interface ProgramFile {
  data: string;
  address: number;
}

export interface StdOut {
  write: (data: string) => void;
}

export interface ProgramConfig {
  bin?: Buffer | string;
  files?: ProgramFile[];
  speed?: number;
  uploadSpeed?: number;
  tool?: string;
  cpu?: string;
  verbose?: boolean;
  flashMode?: string;
  flashFreq?: string;
  avr109Reconnect?: (opts: ReconnectParams) => Promise<SerialPort>;
  stdout?: StdOut;
}

export const upload = async (serial: SerialPort, config: ProgramConfig) => {
  if (!config.bin && !config.files?.length) {
    throw new Error('No hex or files provided for upload');
  }
  if (!config.bin && config.files?.length) {
    config.bin = Buffer.from(config.files[0].data, 'base64');
  }
  if (typeof config.bin === 'string') {
    config.bin = Buffer.from(config.bin, 'base64');
  }
  if (!config.stdout) {
    config.stdout = process?.stdout || {
      write: (str: string) => console.log(str.replace(/(\n|\r)+$/g, '')),
    };
  }
  // ensure serial port is open
  if (!serial.isOpen) {
    if (!serial.opening) serial.open();
    await waitForOpen(serial);
  }

  // set uploading baud rate
  const existingBaud = serial.baudRate;
  if (config.speed && config.speed !== serial.baudRate) {
    await setBaud(serial, config.speed);
  }

  // upload using the correct tool/protocol
  switch (config.tool) {
    case 'avr':
    case 'avrdude':
      await avr.upload(serial, config);
      break;
    case 'esptool':
    case 'esptool_py':
      await esp.upload(serial, config);
      break;
    default:
      throw new Error(`Tool ${config.tool} not supported`);
  }
  
  // restore original baud rate
  if (serial.baudRate !== existingBaud) {
    await setBaud(serial, existingBaud);
  }
};

export const isSupported = (tool: string, cpu: string) => {
  switch (tool) {
    case 'avr':
    case 'avrdude':
      return avr.isSupported(cpu);
      case 'esptool':
      case 'esptool_py':
        return esp.isSupported(cpu);
    default:
      return false;
  }
}
