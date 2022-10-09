import { SerialPort } from 'serialport/dist/index.d';
import YAML from 'yaml';
import fs from 'fs';
import axios from 'axios';
import path from 'path';
import { ProgramFile } from '../src/index.d';

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
      reject(new Error('Timeout'));
    }, timeout || 1000);
    serial.on('data', handleData);
    cleanup = () => {
      serial.off('data', handleData);
      clearTimeout(timer);
    }
  });
};

export const config = YAML.parse(fs.readFileSync(path.join(__dirname, 'test-config.yml'), 'utf8'));

interface HexResult {
  hex?: Buffer;
  files?: ProgramFile[];
  key: string;
  code: string;
}

export const getHex = async (file: string, fqbn: string): Promise<HexResult> => {
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
  return {
    hex: res.data.hex ? Buffer.from(res.data.hex, 'base64') : undefined,
    files: res.data.files as ProgramFile[],
    key,
    code,
  } as HexResult;
};
