import { SerialPort } from 'serialport/dist/index.d';

import { setBaud, waitForOpen } from './util/serial-helpers';
import avr from './avr/index';
import esp from './esp/index';

export interface ProgramFile {
  data: string;
  address: number;
}

export interface ProgramConfig {
  hex?: Buffer;
  files?: ProgramFile[];
  speed?: number;
  uploadSpeed?: number;
  tool?: string;
  cpu?: string;
  verbose?: boolean;
  flashMode?: string;
  flashFreq?: string;
  avr109Reconnect?: () => Promise<SerialPort>;
}

export const upload = async (serial: SerialPort, config: ProgramConfig) => {
  if (!config.hex && !config.files?.length) {
    throw new Error('No hex or files provided for upload');
  }
  // ensure serial port is open
  if (!serial.isOpen) {
    serial.open();
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
