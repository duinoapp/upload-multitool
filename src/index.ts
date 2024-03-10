import type { SerialPort } from 'serialport/dist/index.d';
import { SerialPortPromise as SPP } from './serialport/serialport-promise';
import { WebSerialPort as WSP, WebSerialPortPromise as WSPP } from './serialport/web-serialport';

import { setBaud, waitForOpen, castToSPP } from './util/serial-helpers';
import { ReconnectParams } from './avr/avr109/avr109';
import avr from './avr/index';
import esp from './esp/index';

export class SerialPortPromise extends SPP {}
export class WebSerialPort extends WSP {}
export class WebSerialPortPromise extends WSPP {}

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
  speed?: number; // baud rate to connect to bootloader
  uploadSpeed?: number; // baud rate to use for upload (ESP)
  tool?: string;
  cpu?: string;
  verbose?: boolean;
  flashMode?: string;
  flashFreq?: string;
  avr109Reconnect?: (opts: ReconnectParams) => Promise<SerialPort>;
  stdout?: StdOut;
}

export const upload = async (serialport: SerialPort | SerialPortPromise, config: ProgramConfig) => {
  const serial = castToSPP(serialport);
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
  const ts = Date.now();
  // ensure serial port is open
  if (!serial.isOpen) {
    await serial.open();
    await waitForOpen(serial);
  }

  // set uploading baud rate
  const existingBaud = serial.baudRate;
  if (config.speed && config.speed !== serial.baudRate) {
    await setBaud(serial, config.speed);
  }

  let newPort: SerialPortPromise | undefined;
  // upload using the correct tool/protocol
  switch (config.tool) {
    case 'avr':
    case 'avrdude':
      newPort = await avr.upload(serial, config);
      break;
    case 'esptool':
    case 'esptool_py':
      newPort = await esp.upload(serial, config);
      break;
    default:
      throw new Error(`Tool ${config.tool} not supported`);
  }
  
  // restore original baud rate
  if (newPort.baudRate !== existingBaud) {
    await setBaud(newPort, existingBaud);
  }

  return {
    serialport: newPort,
    time: Date.now() - ts,
  };
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
