import { PortInfo } from '@serialport/bindings-interface';
import YAML from 'yaml';
import fs from 'fs';
import axios from 'axios';
import path from 'path';
import { SerialPort } from 'serialport';
import { ProgramFile } from '../src/index';
import ESPLoader from '../src/esp/loader';
import { waitForOpen } from '../src/util/serial-helpers';
import asyncTimeout from '../src/util/async-timeout';

export const waitForData = (
  serial: SerialPort,
  key: string,
  timeout: number,
): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    let cleanup = () => {};
    const handleData = (data: Buffer) => {
      // console.log(data.toString('utf-8'));
      if (data.toString('utf-8').includes(key)) {
        cleanup();
        resolve(true);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout waiting for data'));
    }, timeout || 1000);
    serial.on('data', handleData);
    cleanup = () => {
      serial.off('data', handleData);
      clearTimeout(timer);
    }
  });
};

interface Device {
  name: string;
  vendorIds?: string[];
  productIds?: string[];
  espChip?: string;
  mac?: string;
  code: string;
  fqbn: string;
  cpu: string;
  tool: string;
  speed: number;
  uploadSpeed?: number;
}

interface TestConfig {
  devices: {
    [key: string]: Device;
  };
  compileServer: string;
  verbose?: boolean;
  retries?: number;
}

export const config = YAML.parse(fs.readFileSync(path.join(__dirname, 'test-config.yml'), 'utf8')) as TestConfig;

interface HexResult {
  bin?: Buffer;
  files?: ProgramFile[];
  key: string;
  code: string;
  flashMode?: string;
  flashFreq?: string;
}

export const getBin = async (file: string, fqbn: string): Promise<HexResult> => {
  const key = Math.random().toString(16).substring(7);
  const code = fs
    .readFileSync(path.join(__dirname, `code/${file}.ino`), 'utf8')
    .replace(/{{key}}/g, key);
  const res = await axios.post(`${config.compileServer}/v3/compile`, {
    fqbn,
    files: [{
      content: code,
      name: `${file}/${file}.ino`,
    }],
  });
  // console.log({ ...res.data, files: null });
  // fs.writeFileSync(path.join(__dirname, `compiled-data.json`), JSON.stringify(res.data, null, 2));
  return {
    bin: res.data.hex ? Buffer.from(res.data.hex, 'base64') : undefined,
    files: res.data.files as ProgramFile[],
    key,
    code,
    flashMode: res.data.flash_mode,
    flashFreq: res.data.flash_freq,
  } as HexResult;
};

export interface ESPIdentifyResult extends PortInfo {
  esp?: {
    chip: string;
    type: string;
    mac: string;
  }
}

const pollDevices = async (
  espCount: number,
  existingList = [] as PortInfo[],
  count = 0
): Promise<PortInfo[]> => {
  const list = await SerialPort.list();
  const newList = list.reduce((acc, p) => {
    if (!acc.find(a => a.path === p.path)) acc.push(p);
    return acc;
  }, existingList);
  const numEsps = newList.filter(p => p.vendorId === '1a86' && p.productId === '7523').length;
  if (numEsps >= espCount) return newList;
  if (count > 20) throw new Error('Could not detect enough ESPs');
  await asyncTimeout(250 + (Math.random() * 500));
  return pollDevices(espCount, newList, count + 1);
};

const espIdentifyDevice = async (port: PortInfo): Promise<ESPIdentifyResult> => {
  const serial = new SerialPort({ path: port.path, baudRate: 115200 });
  await waitForOpen(serial);
  const loader = new ESPLoader(serial, { quiet: true });
  await loader.detectChip();
  if (!loader.chip) throw new Error('Could not detect chip');
  const type = loader.chip.CHIP_NAME;
  const chip = await loader.chip.getChipDescription(loader);
  const mac = await loader.chip.readMac(loader);
  await loader.reboot();
  await serial.close();
  console.log('Identified', port.path, type, '-', chip, '-', mac);
  return {
    ...port,
    esp: { chip, type, mac },
  };
}

export const espIdentify = async (espCount: number): Promise<ESPIdentifyResult[]> => {
  const list = await pollDevices(espCount);
  const results = [] as ESPIdentifyResult[];
  await list.reduce(async (promise, port) => {
    await promise;
    if (port.vendorId === '1a86' && port.productId === '7523') {
      results.push(await espIdentifyDevice(port));
    } else {
      results.push({ ...port });
    }
  }, Promise.resolve());
  return results;
}

export const waitForDevice = async (device: Device, count = 0): Promise<PortInfo | null> => {
  const list = await SerialPort.list();
  // console.log(list.filter(p => p.vendorId));
  const port = list.find(p => device.vendorIds?.includes(p.vendorId || '') && device.productIds?.includes(p.productId || ''));
  if (port) return port;
  if (count > 20) return null;
  await asyncTimeout(100 + (Math.random() * 500));
  return waitForDevice(device, count + 1);
}