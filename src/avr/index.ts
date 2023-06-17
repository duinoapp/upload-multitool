import { SerialPort } from 'serialport/dist/index.d';
import { ProgramConfig } from '../index';

import intelHex from 'intel-hex';
import getCpuData from './avr-cpu-data';
import STK500v1 from './stk500-v1/stk500-v1';
import STK500v2 from './stk500-v2/stk500-v2';
import AVR109 from './avr109/avr109';

export const upload = async (serial: SerialPort, config: ProgramConfig) => {
  const cpuData = getCpuData(config.cpu);
  let uploader = null as STK500v2 | STK500v1 | AVR109 | null;
  switch (cpuData.protocol) {
    case 'stk500v1':
      uploader = new STK500v1(serial, {
        quiet: !config.verbose,
        stdout: config.stdout,
      });
      await uploader.bootload(
        intelHex.parse(config.bin || '').data,
        {
          signature: cpuData.signature,
          pageSize: cpuData.pageSize,
          timeout: cpuData.timeout,
        },
      );
      break;
      case 'stk500v2':
        uploader = new STK500v2(serial, {
          quiet: !config.verbose,
          stdout: config.stdout,
        });
        await uploader.bootload(
          intelHex.parse(config.bin || '').data,
          cpuData,
        );
        break;
      case 'avr109':
        if (!config.avr109Reconnect) {
          throw new Error('avr109Reconnect function not provided');
        }
        uploader = new AVR109(serial, {
          quiet: !config.verbose,
          stdout: config.stdout,
          avr109Reconnect: config.avr109Reconnect,
        });
        await uploader.bootload(
          intelHex.parse(config.bin || '').data,
          cpuData,
        );
        break;
    default:
      throw new Error(`Protocol ${cpuData.protocol} not supported`);
  }
};

export const isSupported = (cpu: string) => {
  try {
    const cpuData = getCpuData(cpu);
    return ['stk500v1', 'stk500v2', 'avr109'].includes(cpuData.protocol);
  } catch (e) {
    return false;
  }
};

export default { upload, isSupported };
