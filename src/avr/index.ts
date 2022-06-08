import { SerialPort } from 'serialport/dist/index.d';
import { ProgramConfig } from '../index.d';

import intelHex from 'intel-hex';
import getCpuData from './avr-cpu-data';
import STK500v1 from './stk500-v1/stk500-v1';
import STK500v2 from './stk500-v2/stk500-v2';

export const upload = async (serial: SerialPort, config: ProgramConfig) => {
  const cpuData = getCpuData(config.cpu);
  let uploader = null as STK500v2 | STK500v1 | null;
  switch (cpuData.protocol) {
    case 'stk500v1':
      uploader = new STK500v1(serial, { quiet: !config.verbose });
      await uploader.bootload(
        intelHex.parse(config.hex || '').data,
        {
          signature: cpuData.signature,
          pageSize: cpuData.pageSize,
          timeout: cpuData.timeout,
        },
      );
      break;
      case 'stk500v2':
        uploader = new STK500v2(serial, { quiet: !config.verbose });
        await uploader.bootload(
          intelHex.parse(config.hex || '').data,
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
    return ['stk500v1'].includes(cpuData.protocol);
  } catch (e) {
    return false;
  }
};

export default { upload, isSupported };
